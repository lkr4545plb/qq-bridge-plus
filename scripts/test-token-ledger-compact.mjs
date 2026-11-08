// token 账本的**压缩/淘汰**回归（t-ledger-compact）。
//
// 背景（这是一个有实测的 P1）：
//   `maybeCompact()` 旧判断是 `journalLines <= maxLines && samples.size <= maxLines && !evictedDirty`，
//   而 `compact()` 写完把 `journalLines` 设成**实际写出的行数** —— 那里面含全部 samples（可达
//   maxLines=20000）+ baselines + evicted，永远大于 maxLines。于是账本一跑满，**每条事件**都会
//   整文件重写一次，并且每次都只淘汰 1 条（`evictOldestSamples` 的 overflow = size - maxLines）。
//
//   实测（20000 条已饱和的账本，再连续 ingest 200 条事件）：
//     修前：整文件重写 200 次、序列化 674.9 MB、10.2 s
//     修后：整文件重写   1 次、序列化   3.0 MB、0.14 s
//
// 本文件钉住五条：批量淘汰、饱和后不再逐条重写、maxLines 归一、失败清理临时文件、
// 以及**最要紧的那条业务不变量**——淘汰不能丢累计总量。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TOKEN_LEDGER_MAX_LINES_DEFAULT,
  TOKEN_LEDGER_MAX_LINES_MAX,
  createTokenLedger,
  normalizeTokenLedgerMaxLines
} from '../src/token-ledger.js';

/** 临时目录；测试结束统一删掉（绝不碰仓库 state/）。 */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ledger-compact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 固定的空闲档时间（周一 20:00 北京时间），避免峰谷让金额随跑测试的时刻变化。 */
const AT = Date.parse('2026-11-02T20:00:00+08:00');
const USAGE = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 };

const evMsg = (seq, turn) => ({ seq, time: AT, type: 'assistant/message', data: { turn, step: 1, usage: USAGE } });

/** 造一个"已经跑满"的账本文件：`count` 条 turn 行，一次写盘（不计入下面的统计）。 */
function seedFullJournal(file, count) {
  const row = (i) => JSON.stringify({
    k: 'turn', t: AT, sid: 's1', key: 'group:100', seq: i, turn: i + 1, step: 1, retry: 0,
    b: { cacheMiss: 10, cacheHit: 0, cacheWrite: 0, output: 1, reasoning: 0 }
  });
  const lines = [];
  for (let i = 0; i < count; i += 1) lines.push(row(i));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

/**
 * 统计"整文件重写"次数。
 *
 * 只数 `compact()` 的写：它写临时文件时带 `mode: 0o600`。
 * 不能用"所有 writeFileSync"——Node 的 `appendFileSync` 内部就是
 * `writeFileSync(..., { flag: 'a' })`，会把 200 次追加也算进来（第一次写这个基准时就踩了）。
 */
function countCompacts(t) {
  const original = fs.writeFileSync;
  const state = { compacts: 0, bytes: 0 };
  fs.writeFileSync = (...args) => {
    const opts = args[2];
    if (opts && typeof opts === 'object' && opts.mode === 0o600) {
      state.compacts += 1;
      state.bytes += String(args[1] ?? '').length;
    }
    return original.apply(fs, args);
  };
  t.after(() => { fs.writeFileSync = original; });
  return state;
}

// ── 1. 饱和后不再逐条重写 ──────────────────────────────────────────────────
test('账本饱和后连续 ingest 200 条事件，整文件重写 ≤ 5 次（修前是 200 次）', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'token-usage.jsonl');
  const MAX = 20000;
  seedFullJournal(file, MAX);

  const ledger = createTokenLedger({ file, maxLines: MAX });
  assert.equal(ledger.stats().samples, MAX, '前置：载入后正好跑满');

  const counted = countCompacts(t);
  for (let i = 0; i < 200; i += 1) ledger.ingestEvent({ sessionId: 's1', event: evMsg(MAX + i, MAX + i + 1) });

  assert.ok(counted.compacts <= 5, `整文件重写应 ≤ 5 次，实得 ${counted.compacts} 次`);
  assert.ok(counted.compacts >= 1, '至少要有一次（第一次越界必须淘汰并重写）');
  assert.ok(counted.bytes < 20 * 1024 * 1024, `累计序列化应 < 20MB，实得 ${(counted.bytes / 1048576).toFixed(1)}MB`);
});

test('重写之后的那一条 ingest 不会立刻再触发重写', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'token-usage.jsonl');
  const MAX = 2000;
  seedFullJournal(file, MAX);
  const ledger = createTokenLedger({ file, maxLines: MAX });

  const counted = countCompacts(t);
  ledger.ingestEvent({ sessionId: 's1', event: evMsg(MAX, MAX + 1) });   // 越界 → 淘汰 + 重写
  const afterFirst = counted.compacts;
  assert.equal(afterFirst, 1, '第一次越界应正好重写一次');

  for (let i = 1; i <= 20; i += 1) ledger.ingestEvent({ sessionId: 's1', event: evMsg(MAX + i, MAX + i + 1) });
  assert.equal(counted.compacts, afterFirst, '接下来的 20 条都在死区内，不该再重写');
});

// ── 2. 批量淘汰 ────────────────────────────────────────────────────────────
test('越界一次就淘汰到 maxLines × 0.9，而不是只淘汰 1 条', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'token-usage.jsonl');
  const MAX = 200;
  seedFullJournal(file, MAX);
  const ledger = createTokenLedger({ file, maxLines: MAX });

  assert.equal(ledger.stats().samples, MAX);
  ledger.ingestEvent({ sessionId: 's1', event: evMsg(MAX, MAX + 1) });

  const after = ledger.stats().samples;
  assert.ok(after <= Math.floor(MAX * 0.9), `应一次淘汰到 ${Math.floor(MAX * 0.9)} 以内，实得 ${after}`);
  assert.ok(after >= 1, '不能把明细清空');
});

test('多次越界后明细规模稳定在 (0.9, 1.0] × maxLines 区间', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'token-usage.jsonl');
  const MAX = 100;
  const ledger = createTokenLedger({ file, maxLines: MAX });
  for (let i = 0; i < 1000; i += 1) {
    ledger.ingestEvent({ sessionId: 's1', event: evMsg(i, i + 1) });
    const size = ledger.stats().samples;
    assert.ok(size <= MAX, `任意时刻明细不得超过上限（第 ${i} 条后实得 ${size}）`);
  }
  assert.ok(ledger.stats().samples > 0, '最终仍有明细');
});

// ── 3. maxLines 归一 ───────────────────────────────────────────────────────
test('normalizeTokenLedgerMaxLines：只接受 1..1e5 的整数，其余回默认', () => {
  const D = TOKEN_LEDGER_MAX_LINES_DEFAULT;
  for (const bad of [Infinity, -Infinity, NaN, 0, -1, 1e6, TOKEN_LEDGER_MAX_LINES_MAX + 1, 2.5, 'abc', null, undefined, true]) {
    assert.equal(normalizeTokenLedgerMaxLines(bad), D, `${String(bad)} 应回默认`);
  }
  assert.equal(normalizeTokenLedgerMaxLines(1), 1);
  assert.equal(normalizeTokenLedgerMaxLines(50), 50);
  assert.equal(normalizeTokenLedgerMaxLines(TOKEN_LEDGER_MAX_LINES_MAX), TOKEN_LEDGER_MAX_LINES_MAX);
  assert.equal(normalizeTokenLedgerMaxLines('200'), 200, '数字字符串可用');
  assert.equal(normalizeTokenLedgerMaxLines(20000.0), 20000);
});

test('createTokenLedger 会把非法 maxLines 夹到默认值（Infinity 不会变成"永不压缩"）', (t) => {
  const dir = tempDir(t);
  for (const [i, value] of [Infinity, NaN, 0, 1e9].entries()) {
    const file = path.join(dir, `l${i}.jsonl`);
    const ledger = createTokenLedger({ file, maxLines: value });
    assert.equal(ledger.stats().maxLines, TOKEN_LEDGER_MAX_LINES_DEFAULT, `${String(value)} 应回默认`);
  }
});

test('maxLines=1 这种极端值也不会死循环或清空（每次只留 1 条）', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'token-usage.jsonl');
  const ledger = createTokenLedger({ file, maxLines: 1 });
  for (let i = 0; i < 5; i += 1) ledger.ingestEvent({ sessionId: 's1', event: evMsg(i, i + 1) });
  assert.equal(ledger.stats().samples, 1, '上限 1 时保留 1 条');
});

// ── 4. 压缩失败：清理临时文件 + 下次重试 ──────────────────────────────────
test('compact 失败不留 .tmp 残留，且下一次 ingest 会重试成功', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'token-usage.jsonl');
  const ledger = createTokenLedger({ file, maxLines: 5 });

  // 让写临时文件这一步失败（appendFileSync 走的是另一条路径，不受影响）
  const original = fs.writeFileSync;
  let failures = 0;
  fs.writeFileSync = (...args) => {
    const opts = args[2];
    if (opts && typeof opts === 'object' && opts.mode === 0o600) {
      failures += 1;
      throw new Error('fixture: 磁盘写失败');
    }
    return original.apply(fs, args);
  };

  try {
    for (let i = 0; i < 8; i += 1) ledger.ingestEvent({ sessionId: 's1', event: evMsg(i, i + 1) });
  } finally {
    fs.writeFileSync = original;
  }

  assert.ok(failures > 0, '前置：确实触发过压缩且失败了');
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], `失败后不应残留临时文件，实得 ${leftovers.join(',')}`);

  // 恢复后继续 ingest：淘汰汇总仍是"脏"的，必须补一次成功的重写
  for (let i = 8; i < 12; i += 1) ledger.ingestEvent({ sessionId: 's1', event: evMsg(i, i + 1) });
  const stats = ledger.stats();
  assert.ok(stats.journalLines > 0, '重试后文件行数正常');
  assert.ok(fs.readdirSync(dir).every((name) => !name.endsWith('.tmp')), '成功路径也不该留临时文件');

  // 重新载入能读回同样的明细数（说明重写后的文件是完整的）
  const reloaded = createTokenLedger({ file, maxLines: 5 });
  assert.equal(reloaded.stats().samples, stats.samples, '重写后的文件可被重新载入');
});

// ── 5. 淘汰不丢总量（既有语义） ───────────────────────────────────────────
test('淘汰后累计总量与未淘汰时完全一致，差额进「未逐轮归属」', (t) => {
  const dir = tempDir(t);
  const small = path.join(dir, 'small.jsonl');
  const big = path.join(dir, 'big.jsonl');

  // 同一批 30 条事件：一个账本上限很小（必然淘汰），一个上限很大（全部保留）
  const evictedLedger = createTokenLedger({ file: small, maxLines: 10 });
  const fullLedger = createTokenLedger({ file: big, maxLines: 10000 });
  for (let i = 0; i < 30; i += 1) {
    evictedLedger.ingestEvent({ sessionId: 's1', event: evMsg(i, i + 1) });
    fullLedger.ingestEvent({ sessionId: 's1', event: evMsg(i, i + 1) });
  }

  const a = evictedLedger.summary().totals;
  const b = fullLedger.summary().totals;
  assert.deepEqual(a.buckets, b.buckets, '桶累计必须逐字段一致（淘汰只丢归属，不丢用量）');
  // 金额是浮点累加：淘汰路径按"每条采样求和"，保留路径在 summary 里折叠，末尾几位必然有噪声。
  assert.ok(Math.abs(a.cost - b.cost) < 1e-12, `花费必须一致（差 ${Math.abs(a.cost - b.cost)}）`);
  assert.equal(a.buckets.cacheMiss, 300, '30 × 10');
  assert.equal(a.buckets.output, 30, '30 × 1');
  assert.ok(a.unattributedCost > 0, '被淘汰的回合归入「未逐轮归属」');
  assert.ok(evictedLedger.stats().samples <= 10, '明细确实被压到上限内');

  // 跨重启也要能复现同样的总额
  const reloaded = createTokenLedger({ file: small, maxLines: 10 });
  const c = reloaded.summary().totals;
  assert.ok(Math.abs(c.cost - a.cost) < 1e-12, '淘汰结果跨重启可复现');
  assert.deepEqual(c.buckets, a.buckets);
});

test('reset() 之后不会把"已删除的淘汰汇总"重新写回磁盘', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'token-usage.jsonl');
  const ledger = createTokenLedger({ file, maxLines: 5 });
  for (let i = 0; i < 12; i += 1) ledger.ingestEvent({ sessionId: 's1', event: evMsg(i, i + 1) });
  assert.ok(ledger.summary().totals.cost > 0);

  ledger.reset();
  assert.equal(ledger.summary().totals.cost, 0, '重置后总额归零');
  assert.equal(ledger.stats().journalLines, 0);

  ledger.ingestEvent({ sessionId: 's2', event: evMsg(100, 1) });
  const totals = ledger.summary().totals;
  const single = 10 / 1e6 * 1 + 1 / 1e6 * 4; // 仅供量级断言，价格随价目表变化不参与比较
  assert.ok(totals.cost > 0 && totals.cost <= Math.max(single * 4, 0.001), '重置后只有新会话的花费，旧总额不会复活');
});
