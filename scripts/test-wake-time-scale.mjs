// 唤醒概率时段缩放（src/core/wake-time-scale.mjs）的直测。
//
// 这一层要钉住三件事：
//   1) 窗口算术（含跨零点、end 开区间、起止相同视为配坏）；
//   2) 乘数语义（睡觉 ×0.2、波峰 ×0.5、同时命中相乘、关掉就是 1）；
//   3) 非法输入一律夹紧，绝不出现 "scale = NaN"（那会让 `random < NaN` 恒为假，
//      等于把唤醒彻底关死而且没有任何日志）。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WAKE_TIME_SCALE_DEFAULTS,
  describeWakeTimeScale,
  isHourInWindow,
  normalizeWakeTimeScaleConfig,
  wakeTimeScale,
} from '../src/core/wake-time-scale.mjs';

// ── 配置归一 ────────────────────────────────────────────────────────────────
test('normalizeWakeTimeScaleConfig：缺省即开启，且回默认值', () => {
  for (const raw of [undefined, null, 'x', [], {}]) {
    const c = normalizeWakeTimeScaleConfig(raw);
    assert.equal(c.enabled, true);
    assert.deepEqual(
      { start: c.sleep.startHour, end: c.sleep.endHour, scale: c.sleep.scale },
      { start: 0, end: 8, scale: 0.2 }
    );
    assert.equal(c.dsPeak.scale, 0.5);
    assert.equal(c.sleep.degenerate, false);
  }
});

test('normalizeWakeTimeScaleConfig：scale 与小时都夹紧，脏值回默认', () => {
  const c = normalizeWakeTimeScaleConfig({
    sleep: { startHour: -3, endHour: 99, scale: 5 },
    dsPeak: { scale: -1 },
  });
  assert.equal(c.sleep.startHour, 0);
  assert.equal(c.sleep.endHour, 23);
  assert.equal(c.sleep.scale, 1);
  assert.equal(c.dsPeak.scale, 0);

  const dirty = normalizeWakeTimeScaleConfig({ sleep: { scale: 'abc', startHour: null }, dsPeak: { scale: true } });
  assert.equal(dirty.sleep.scale, WAKE_TIME_SCALE_DEFAULTS.sleep.scale);
  assert.equal(dirty.sleep.startHour, WAKE_TIME_SCALE_DEFAULTS.sleep.startHour);
  assert.equal(dirty.dsPeak.scale, WAKE_TIME_SCALE_DEFAULTS.dsPeak.scale);
});

test('normalizeWakeTimeScaleConfig：起止相同视为配坏，退回默认并打标', () => {
  const c = normalizeWakeTimeScaleConfig({ sleep: { startHour: 8, endHour: 8 } });
  assert.equal(c.sleep.degenerate, true);
  assert.equal(c.sleep.startHour, WAKE_TIME_SCALE_DEFAULTS.sleep.startHour);
  assert.equal(c.sleep.endHour, WAKE_TIME_SCALE_DEFAULTS.sleep.endHour);
});

test('normalizeWakeTimeScaleConfig：enabled:false 只认显式 false', () => {
  assert.equal(normalizeWakeTimeScaleConfig({ enabled: false }).enabled, false);
  assert.equal(normalizeWakeTimeScaleConfig({ enabled: 0 }).enabled, true);
  assert.equal(normalizeWakeTimeScaleConfig({ enabled: 'false' }).enabled, true);
  assert.equal(normalizeWakeTimeScaleConfig({ sleep: { enabled: false } }).sleep.enabled, false);
});

// ── 窗口算术 ────────────────────────────────────────────────────────────────
test('isHourInWindow：普通窗口、跨零点、end 开区间', () => {
  assert.equal(isHourInWindow(3, 0, 8), true);
  assert.equal(isHourInWindow(0, 0, 8), true);
  assert.equal(isHourInWindow(7, 0, 8), true);
  assert.equal(isHourInWindow(8, 0, 8), false, 'end 是开区间');
  assert.equal(isHourInWindow(12, 0, 8), false);

  // 跨零点：22 → 6 表示 [22,24) ∪ [0,6)
  assert.equal(isHourInWindow(23, 22, 6), true);
  assert.equal(isHourInWindow(0, 22, 6), true);
  assert.equal(isHourInWindow(5, 22, 6), true);
  assert.equal(isHourInWindow(6, 22, 6), false);
  assert.equal(isHourInWindow(12, 22, 6), false);

  // 起止相同 = 空窗口
  assert.equal(isHourInWindow(5, 5, 5), false);
});

// ── 乘数 ────────────────────────────────────────────────────────────────────
test('wakeTimeScale：睡觉时段 ×0.2，常规时段 ×1', () => {
  const night = wakeTimeScale({ hour: 3 }, {});
  assert.equal(night.scale, 0.2);
  assert.equal(night.sleep, true);
  assert.deepEqual(night.matches, ['sleep']);

  const day = wakeTimeScale({ hour: 15 }, {});
  assert.equal(day.scale, 1);
  assert.deepEqual(day.matches, []);
});

test('wakeTimeScale：DS 波峰 ×0.5，睡觉与波峰同时命中相乘', () => {
  const peak = wakeTimeScale({ hour: 10, isDsPeak: true }, {});
  assert.equal(peak.scale, 0.5);
  assert.deepEqual(peak.matches, ['dsPeak']);

  const both = wakeTimeScale({ hour: 3, isDsPeak: true }, {});
  assert.equal(both.scale, Number((0.2 * 0.5).toFixed(10)));
  assert.deepEqual(both.matches, ['sleep', 'dsPeak']);
});

test('wakeTimeScale：总开关关掉 → 恒 1，即使命中两个窗口', () => {
  const r = wakeTimeScale({ hour: 3, isDsPeak: true }, { enabled: false });
  assert.equal(r.scale, 1);
  assert.equal(r.disabled, true);
  assert.deepEqual(r.matches, []);
});

test('wakeTimeScale：单窗口关掉只影响自己', () => {
  const conf = { sleep: { enabled: false, scale: 0.2 }, dsPeak: { enabled: true, scale: 0.5 } };
  assert.equal(wakeTimeScale({ hour: 3 }, conf).scale, 1);
  assert.equal(wakeTimeScale({ hour: 10, isDsPeak: true }, conf).scale, 0.5);
});

test('wakeTimeScale：scale 配 0 等于该时段不做软唤醒', () => {
  const r = wakeTimeScale({ hour: 3 }, { sleep: { enabled: true, startHour: 0, endHour: 8, scale: 0 } });
  assert.equal(r.scale, 0);
  assert.equal(r.sleep, true);
});

test('wakeTimeScale：非法 hour / isDsPeak 不会产生 NaN', () => {
  for (const hour of [NaN, null, undefined, 'x', -5, 99]) {
    const r = wakeTimeScale({ hour, isDsPeak: 'yes' }, {});
    assert.ok(Number.isFinite(r.scale), `hour=${String(hour)} 产生了 ${r.scale}`);
    assert.ok(r.scale >= 0 && r.scale <= 1);
  }
});

// ── 人话描述 ────────────────────────────────────────────────────────────────
test('describeWakeTimeScale：常规/睡觉/波峰/关掉都有人话', () => {
  assert.equal(describeWakeTimeScale(wakeTimeScale({ hour: 15 }, {}), {}), '常规时段 ×1');
  assert.match(describeWakeTimeScale(wakeTimeScale({ hour: 3 }, {}), {}), /睡觉时段\(0–8点\) ×0\.2/);
  assert.match(describeWakeTimeScale(wakeTimeScale({ hour: 10, isDsPeak: true }, {}), {}), /DS 波峰 ×0\.5/);
  assert.equal(describeWakeTimeScale(wakeTimeScale({ hour: 3 }, { enabled: false }), { enabled: false }), '不限时段');
});
