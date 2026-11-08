// 记忆注入预算（src/core/memory-budget.mjs）的直测。
//
// 这一层的核心承诺只有两条，测试就盯着这两条：
//   1) **输出永不超过预算**（随机大量用例覆盖，不是抽查）；
//   2) 裁剪**一定会留痕**（说明文案出现，且计数与实际丢掉的行一致），否则模型会以为
//      记忆是空的，转头把同样的东西再记一遍 —— 省下的 token 又花回去。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEMORY_INJECT_MAX_CHARS_DEFAULT,
  MEMORY_INJECT_MAX_CHARS_MAX,
  MEMORY_INJECT_MAX_CHARS_MIN,
  MEMORY_TRAITS_RENDER_MAX_DEFAULT,
  clipTraits,
  normalizeMemoryInjectConfig,
  planMemoryInject,
} from '../src/core/memory-budget.mjs';

// ── 配置归一 ────────────────────────────────────────────────────────────────
test('normalizeMemoryInjectConfig：缺省/类型不对一律回默认（不落到下限）', () => {
  for (const raw of [undefined, null, true, 'abc', [], {}, { maxInjectChars: null }, { maxInjectChars: true }]) {
    const conf = normalizeMemoryInjectConfig(raw);
    assert.equal(conf.maxInjectChars, MEMORY_INJECT_MAX_CHARS_DEFAULT, JSON.stringify(raw));
    assert.equal(conf.traitsRenderMax, MEMORY_TRAITS_RENDER_MAX_DEFAULT, JSON.stringify(raw));
  }
});

test('normalizeMemoryInjectConfig：字符串数字可用，越界夹紧，小数取整', () => {
  assert.equal(normalizeMemoryInjectConfig({ maxInjectChars: '2400' }).maxInjectChars, 2400);
  assert.equal(normalizeMemoryInjectConfig({ maxInjectChars: 12 }).maxInjectChars, MEMORY_INJECT_MAX_CHARS_MIN);
  assert.equal(normalizeMemoryInjectConfig({ maxInjectChars: 999999 }).maxInjectChars, MEMORY_INJECT_MAX_CHARS_MAX);
  assert.equal(normalizeMemoryInjectConfig({ maxInjectChars: 1500.6 }).maxInjectChars, 1501);
  assert.equal(normalizeMemoryInjectConfig({ maxInjectChars: -1 }).maxInjectChars, MEMORY_INJECT_MAX_CHARS_MIN);
  assert.equal(normalizeMemoryInjectConfig({ traitsRenderMax: 99 }).traitsRenderMax, 10);
  assert.equal(normalizeMemoryInjectConfig({ traitsRenderMax: 0 }).traitsRenderMax, 0);
});

// ── traits 截断 ─────────────────────────────────────────────────────────────
test('clipTraits：只影响展示条数，且报出隐藏了几条', () => {
  const traits = ['话多', '爱用梗', '夜猫子', '程序员', '偏好短句'];
  assert.deepEqual(clipTraits(traits, 2), { shown: ['话多', '爱用梗'], hidden: 3 });
  assert.deepEqual(clipTraits(traits, 5), { shown: traits, hidden: 0 });
  assert.deepEqual(clipTraits(traits, 0), { shown: [], hidden: 5 });
});

test('clipTraits：非数组/脏数据不炸，空串被丢弃', () => {
  assert.deepEqual(clipTraits(null, 3), { shown: [], hidden: 0 });
  assert.deepEqual(clipTraits(['a', '', null, 42, 'b'], 5), { shown: ['a', 'b'], hidden: 0 });
  assert.deepEqual(clipTraits(['a', 'b', 'c'], 99), { shown: ['a', 'b', 'c'], hidden: 0 });
});

// ── 预算裁剪 ────────────────────────────────────────────────────────────────
const noteFor = (dropped) => {
  const parts = [];
  if (dropped.topic) parts.push(`话题 ${dropped.topic} 条`);
  if (dropped.impression) parts.push(`印象 ${dropped.impression} 条`);
  if (dropped.thought) parts.push(`想法 ${dropped.thought} 条`);
  return `（记忆已按预算裁剪：省略${parts.join('、')}）`;
};

const line = (text, kind = 'topic') => ({ text, kind });

test('planMemoryInject：未超预算时逐字原样输出，不追加任何说明', () => {
  const sections = [
    { id: 'ownTopics', header: '【进行中的话题】', priority: 4, lines: [line('- 聊猫'), line('- 聊显卡')] },
    { id: 'ownImpressions', header: '【对群友的印象】', priority: 2, lines: [line('- 甲：话多', 'impression')] },
  ];
  const out = planMemoryInject(sections, { maxChars: 1800, noteFor });
  assert.equal(out.truncated, false);
  assert.equal(out.text, '【进行中的话题】\n- 聊猫\n- 聊显卡\n【对群友的印象】\n- 甲：话多');
  assert.deepEqual(out.dropped, { topic: 0, impression: 0, thought: 0 });
});

test('planMemoryInject：空段落连标题一起消失', () => {
  const sections = [
    { id: 'a', header: '【A】', priority: 1, lines: [] },
    { id: 'b', header: '【B】', priority: 2, lines: [line('- x')] },
  ];
  const out = planMemoryInject(sections, { maxChars: 1800 });
  assert.equal(out.text, '【B】\n- x');
});

test('planMemoryInject：先丢最低优先级的段落，丢光后整个段落（含标题）消失', () => {
  // 预算下限是 400，所以用例必须真的超过 400 字才会触发裁剪。
  const sections = [
    { id: 'ownTopics', header: '【话题】', priority: 4, lines: [line(`- ${'话'.repeat(150)}`), line(`- ${'题'.repeat(150)}`)] },
    {
      id: 'shared',
      header: '===== 跨会话共享记忆 =====',
      tail: '===== 共享记忆结束 =====',
      priority: 1,
      lines: [line(`- ${'甲'.repeat(100)}`, 'impression'), line(`- ${'乙'.repeat(100)}`, 'impression'), line(`- ${'丙'.repeat(100)}`, 'impression')],
    },
  ];
  const out = planMemoryInject(sections, { maxChars: MEMORY_INJECT_MAX_CHARS_MIN, noteFor });
  assert.equal(out.truncated, true);
  assert.equal(out.dropped.impression, 3, '低优先级的共享段应被整段丢光');
  assert.equal(out.dropped.topic, 0, '高优先级的话题一行都不该丢');
  assert.ok(!out.text.includes('共享'), '段落被清空后标题也必须消失');
  assert.ok(out.text.includes('【话题】'));
  assert.ok(out.text.includes('（记忆已按预算裁剪'));
  assert.ok(out.chars <= MEMORY_INJECT_MAX_CHARS_MIN, `实际 ${out.chars}`);
});

test('planMemoryInject：dropFrom=start 丢最旧的，end 丢末尾的', () => {
  const rows = () => [line('A'.repeat(300)), line('B'.repeat(150)), line('C'.repeat(150))];
  const startDrop = planMemoryInject(
    [{ id: 't', header: '', priority: 1, dropFrom: 'start', lines: rows() }],
    { maxChars: MEMORY_INJECT_MAX_CHARS_MIN, noteFor }
  );
  assert.ok(startDrop.text.startsWith('B'), `丢最旧：应保留 B 开头，实际 ${startDrop.text.slice(0, 8)}…`);
  assert.ok(!startDrop.text.startsWith('A'));

  const endDrop = planMemoryInject(
    [{ id: 't', header: '', priority: 1, dropFrom: 'end', lines: rows() }],
    { maxChars: MEMORY_INJECT_MAX_CHARS_MIN, noteFor }
  );
  assert.ok(endDrop.text.startsWith('A'), '丢末尾：应保留 A 开头');
  assert.ok(!endDrop.text.includes('C'.repeat(10)), 'C 应已被丢掉');
});

test('planMemoryInject：全部丢光且无说明文案时返回空串，不返回半个标题', () => {
  const out = planMemoryInject([
    { id: 't', header: '【标题】', priority: 1, lines: [line('x'.repeat(1000))] },
  ], { maxChars: 400 });
  assert.equal(out.text, '');
  assert.equal(out.chars, 0);
  assert.equal(out.truncated, true);
});

test('planMemoryInject：反复调用不会就地改写调用方数组', () => {
  const lines = [line('- a'), line('- b')];
  const sections = [{ id: 'x', header: '', priority: 1, lines }];
  planMemoryInject(sections, { maxChars: 400, noteFor });
  assert.equal(lines.length, 2);
});

test('planMemoryInject：随机用例下输出永不超过预算，且计数与裁剪一致', () => {
  let seed = 20261024;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const kinds = ['topic', 'impression', 'thought'];
  for (let round = 0; round < 300; round += 1) {
    const sectionCount = 1 + Math.floor(rand() * 4);
    const sections = [];
    for (let s = 0; s < sectionCount; s += 1) {
      const lineCount = Math.floor(rand() * 12);
      const rows = [];
      for (let i = 0; i < lineCount; i += 1) {
        rows.push(line(`- ${'字'.repeat(Math.floor(rand() * 220))}`, kinds[Math.floor(rand() * 3)]));
      }
      sections.push({
        id: `s${s}`,
        header: rand() > 0.5 ? `【段 ${s}】` : '',
        tail: rand() > 0.8 ? '【尾】' : '',
        priority: Math.floor(rand() * 5),
        dropFrom: rand() > 0.5 ? 'start' : 'end',
        lines: rows,
      });
    }
    const maxChars = MEMORY_INJECT_MAX_CHARS_MIN + Math.floor(rand() * 3000);
    const out = planMemoryInject(sections, { maxChars, noteFor });
    assert.ok(out.chars <= maxChars, `round ${round}: ${out.chars} > ${maxChars}`);
    assert.equal(out.chars, out.text.length);
    const sum = out.dropped.topic + out.dropped.impression + out.dropped.thought;
    assert.equal(out.truncated, sum > 0);
    if (sum > 0) assert.ok(out.text.endsWith('）'), `round ${round}: 裁剪后必须有说明`);
  }
});

test('planMemoryInject：预算非法（NaN/负数/超大）时夹到合法区间而不是崩溃', () => {
  const sections = [{ id: 'a', header: '', priority: 1, lines: [line('x'.repeat(100))] }];
  for (const bad of [NaN, -5, 'abc', Infinity, null]) {
    const out = planMemoryInject(sections, { maxChars: bad });
    assert.ok(out.chars <= MEMORY_INJECT_MAX_CHARS_MAX, String(bad));
    assert.ok(out.chars <= out.budget);
  }
});
