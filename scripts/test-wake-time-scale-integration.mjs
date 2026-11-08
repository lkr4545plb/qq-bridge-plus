// 唤醒概率时段缩放的**接线**测试：跑真实 src/bridge.js（VM + 假 DSH/QQ）。
//
// 这里钉的是整件事最关键的那条不变量：
//   **时段折扣只能作用于"摇概率"的软唤醒，显式触发一律照常醒。**
// 换句话说：scale 配成 0 的深夜，群里 @ 它、叫它名字、问它、拍它、指定成员说话、私聊它，
// 都必须照样唤醒 —— 这是"不能影响人为唤醒"的机器可验证版本。
//
// 顺带验证另外三件容易接错的事：
//   ① 折扣读的是**北京时间**而不是宿主本地时区（原实现用 new Date().getHours()）；
//   ② DS 波峰判定复用 token 计价表（不另立一套窗口）；
//   ③ `triggers.probability` 那一条真的乘上了乘数。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { beijingParts, isPeakAt, resolvePriceTable } from '../src/model-prices.js';
import { busyHarness } from './busy-watchdog-harness.mjs';

const KEY = 'group:456';

/** 构造一段覆盖"当前这个小时"的睡觉窗口（scale 可指定）。 */
function windowAroundNow(scale) {
  const hour = beijingParts(Date.now()).hour;
  return { enabled: true, startHour: hour, endHour: (hour + 1) % 24, scale };
}

/** 只有 probability 一条可能命中的唤醒配置：其它触发器全关。 */
function probabilityOnly(probability) {
  return {
    mode: 'diving',
    infinite: true,
    sleepUntil: null,
    triggers: {
      atMention: false, nameMention: false, speakerIds: [], keywords: [],
      question: false, poke: false, anyMessage: false, probability,
    },
  };
}

async function withBridge(t, config) {
  const bridge = await busyHarness({ config });
  t.after(() => bridge.stop?.());
  return bridge;
}

const plainEvent = () => ({
  self_id: 10000,
  user_id: 111,
  message: [{ type: 'text', data: { text: '今天天气不错' } }],
  sender: { nickname: '甲', card: '甲' },
});

// ── 核心不变量：显式触发不受时段影响 ───────────────────────────────────────
test('scale=0 的时段里，@ 仍然唤醒（显式触发不打折）', async (t) => {
  const bridge = await withBridge(t, {
    socialV2: { wakeTimeScale: { enabled: true, sleep: windowAroundNow(0), dsPeak: { enabled: false } } },
  });
  assert.equal(bridge.wakeTimeScaleNow().scale, 0, '前置：当前时段应被压到 0');

  const st = bridge.getSocialV2State(KEY);
  st.wakeConfig = { ...probabilityOnly(0), triggers: { ...probabilityOnly(0).triggers, atMention: true } };
  const atEvent = { ...plainEvent(), message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 在吗' } }] };

  assert.equal(
    bridge.evaluateWakeTriggerV2(KEY, st, atEvent, 'group', '@小鲸鱼 在吗', '@小鲸鱼 在吗', false),
    'atMention'
  );
});

test('scale=0 的时段里，私聊、追问型提问、指定成员发言仍然唤醒', async (t) => {
  const bridge = await withBridge(t, {
    socialV2: { wakeTimeScale: { enabled: true, sleep: windowAroundNow(0), dsPeak: { enabled: false } } },
  });
  const st = bridge.getSocialV2State(KEY);
  st.wakeConfig = { ...probabilityOnly(0), triggers: { ...probabilityOnly(1).triggers, question: true, speakerIds: ['222'] } };

  // 私聊：直接 return 'private'
  assert.equal(bridge.evaluateWakeTriggerV2('private:111', st, plainEvent(), 'private', '在吗', '在吗', false), 'private');

  // 提问：直接问到 AI
  assert.equal(
    bridge.evaluateWakeTriggerV2(KEY, st, plainEvent(), 'group', '小鲸鱼你觉得 deepseek 比 gpt 强吗', '小鲸鱼你觉得 deepseek 比 gpt 强吗', false),
    'question'
  );

  // 指定成员发言
  const speakerEvent = { ...plainEvent(), user_id: 222, sender: { nickname: '乙', card: '乙' } };
  assert.match(
    String(bridge.evaluateWakeTriggerV2(KEY, st, speakerEvent, 'group', '随便说一句', '随便说一句', false)),
    /^speaker:/
  );
});

test('scale=0 的时段里，关键词仍然唤醒', async (t) => {
  const bridge = await withBridge(t, {
    socialV2: { wakeTimeScale: { enabled: true, sleep: windowAroundNow(0), dsPeak: { enabled: false } } },
  });
  const st = bridge.getSocialV2State(KEY);
  st.wakeConfig = { ...probabilityOnly(0), triggers: { ...probabilityOnly(0).triggers, keywords: ['小鲸鱼'] } };
  assert.equal(
    bridge.evaluateWakeTriggerV2(KEY, st, plainEvent(), 'group', '小鲸鱼今天没来', '小鲸鱼今天没来', false),
    'keyword:小鲸鱼'
  );
});

// ── 概率触发确实被乘数影响 ─────────────────────────────────────────────────
test('scale=0 时 probability 触发永不命中；关掉缩放后 probability=1 必中', async (t) => {
  // ① 折扣到 0
  const zero = await withBridge(t, {
    socialV2: { wakeTimeScale: { enabled: true, sleep: windowAroundNow(0), dsPeak: { enabled: false } } },
  });
  const st0 = zero.getSocialV2State(KEY);
  st0.wakeConfig = probabilityOnly(1);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(zero.evaluateWakeTriggerV2(KEY, st0, plainEvent(), 'group', '今天天气不错', '今天天气不错', false), null);
  }

  // ② 关掉缩放：同一套配置必须命中
  const off = await withBridge(t, {
    socialV2: { wakeTimeScale: { enabled: false, sleep: windowAroundNow(0), dsPeak: { enabled: false } } },
  });
  const st1 = off.getSocialV2State(KEY);
  st1.wakeConfig = probabilityOnly(1);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(off.evaluateWakeTriggerV2(KEY, st1, plainEvent(), 'group', '今天天气不错', '今天天气不错', false), 'probability');
  }
});

// ── 北京时间 & 波峰接线 ────────────────────────────────────────────────────
test('wakeTimeScaleNow 用北京时间判窗口，不受宿主时区影响', async (t) => {
  const bridge = await withBridge(t, {});

  // 北京时间 03:00（= UTC 19:00 前一天）。若实现退回 new Date().getHours()，
  // 在 UTC 云主机上这里会得到 19 点、sleep=false —— 这正是被修掉的那个 bug。
  const night = Date.parse('2026-11-05T03:00:00+08:00');
  const rNight = bridge.wakeTimeScaleNow(night);
  assert.equal(rNight.clock, '03:00');
  assert.equal(rNight.sleep, true);
  assert.equal(rNight.scale, 0.2);

  // 北京时间 20:00：既不在睡觉窗口、也不在 [9,12)/[14,18) 波峰窗口内
  const day = Date.parse('2026-11-05T20:00:00+08:00');
  const rDay = bridge.wakeTimeScaleNow(day);
  assert.equal(rDay.clock, '20:00');
  assert.equal(rDay.sleep, false);
  assert.equal(rDay.dsPeak, false);
  assert.equal(rDay.scale, 1);
});

test('DS 波峰复用 token 计价表的窗口定义（不另立一套）', async (t) => {
  const bridge = await withBridge(t, {});
  const table = resolvePriceTable(undefined);
  // 2026-11-03 是周二（工作日），北京时间 10:00 落在 [9,12) 波峰窗口内
  const peakTs = Date.parse('2026-11-03T10:00:00+08:00');
  const expectedPeak = isPeakAt(peakTs, table);
  assert.equal(expectedPeak, true, '前置：2026-11-03 10:00 应为波峰（写法变了就该重选日期）');

  const r = bridge.wakeTimeScaleNow(peakTs);
  assert.equal(r.dsPeak, true);
  assert.equal(r.scale, 0.5);

  // 周日同一时刻不是波峰（peakWeekdays 只含 1–5）
  const sundayTs = Date.parse('2026-11-08T10:00:00+08:00');
  assert.equal(isPeakAt(sundayTs, table), false);
  assert.equal(bridge.wakeTimeScaleNow(sundayTs).dsPeak, false);
});

test('scaledWakeProbability 同时给出基准值与折后值', async (t) => {
  const bridge = await withBridge(t, {
    socialV2: { wakeTimeScale: { enabled: true, sleep: windowAroundNow(0.5), dsPeak: { enabled: false } } },
  });
  const r = bridge.scaledWakeProbability(0.4);
  assert.equal(r.base, 0.4);
  assert.equal(r.scaled, 0.2);
  assert.equal(r.ws.scale, 0.5);
});

// ── 结构性护栏：不许再退回宿主本地时区 ────────────────────────────────────
test('时段计算只走 beijingParts，不再用 new Date().getHours()', async () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const start = src.indexOf('function wakeTimeScaleNow(');
  assert.ok(start > 0, '找到 wakeTimeScaleNow');
  const body = src.slice(start, src.indexOf('\n  }', start));
  assert.match(body, /beijingParts\(/, '必须用北京时间换算');
  assert.doesNotMatch(body, /getHours\(/, '不得退回宿主本地时区');

  // 主动机会那段硬编码也应已消失
  assert.doesNotMatch(src, /if \(hour >= 23 \|\| hour < 8\) prob \*= 0\.3/, '旧的硬编码夜间衰减应已删除（注释里提到旧写法不算）');

  // 顺序护栏：主动机会里所有启发式调整（待说想法/刚回过话/刷屏）都必须先落到 prob 上，
  // 时段乘数最后乘。写反了不会报错，只会让"刷屏后少主动"这类衰减静默失效。
  const aiDecay = src.indexOf('if (aiCount >= 5) prob *= 0.3;');
  const byTime = src.indexOf('const probByTime =');
  assert.ok(aiDecay > 0 && byTime > 0, '两段代码都在');
  assert.ok(aiDecay < byTime, '时段乘数必须在启发式衰减之后');
});
