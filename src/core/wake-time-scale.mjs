/**
 * 按**时间段缩放唤醒概率**（t-wake-time）：波峰时段、睡觉时段压低"主动/概率"唤醒的频率。
 *
 * 为什么需要这一层
 * ----------------
 * 桥接里有若干**软唤醒**路径是"摇骰子"决定的：主动机会（proactiveCheck）、
 * `wakeConfig.triggers.probability`、一代的 triggerProbability / proactiveProbability /
 * idleRetryProbability。它们与「群友 @ 你」「叫你的名字」「问到 AI」「拍一拍」「指定成员说话」
 * 这些**显式触发**是两回事：
 *
 *   · 显式触发 = 有人找你，必须照常叫醒，任何时段都不能打折；
 *   · 软唤醒   = 你自己想起来说话，半夜和 API 波峰时段就该少想几次。
 *
 * 这段策略此前是硬编码在 bridge 里的一条 `hour >= 23 || hour < 8 → prob *= 0.3`，问题有三：
 *   ① 不可配置（0.3 和 23/8 写死）；
 *   ② 用 `new Date().getHours()` 取**宿主本地时区**，云主机是 UTC 时整段窗口会偏 8 小时；
 *   ③ 与 `socialV2.proactive.activeHours` 硬闸门重叠，实际只剩 7:00–8:00 那一段真正生效，
 *      而这件事没有任何地方写明。
 *
 * 现在把它抽成纯函数：调用方算好**北京时间的小时**与「是否 DS 波峰」（复用 token 计价
 * 那份 `peakWindows / peakWeekdays / holidays` 定义，不另立一套），本模块只做乘法。
 *
 * 语义边界（调用方必须遵守）
 * --------------------------
 *   · 乘数只作用于**概率**：`Math.random() < p * scale`。
 *   · 显式触发（atMention / nameMention / keyword / question / poke / speaker / private /
 *     anyMessage）**不经过本模块**，scale 取 0 也必须照常唤醒 —— 这条由
 *     `scripts/test-wake-time-scale-integration.mjs` 钉死。
 *   · scale = 0 表示该时段不做软唤醒；不做"最小保底"，要保底就把 scale 配成 0.05。
 */

/** 默认值：睡觉时段 0–8 点打两折，DS 波峰打五折，两份同时命中就相乘。 */
export const WAKE_TIME_SCALE_DEFAULTS = Object.freeze({
  enabled: true,
  sleep: Object.freeze({ enabled: true, startHour: 0, endHour: 8, scale: 0.2 }),
  dsPeak: Object.freeze({ enabled: true, scale: 0.5 }),
});

const clampInt = (value, min, max, fallback) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const clampScale = (value, fallback) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
};

/**
 * 归一化配置。数值越界一律夹紧，未知字段丢弃。
 *
 * 注意：**缺省是开启**（`enabled !== false`），因为这一层是"省钱且符合人类作息"的默认行为；
 * 想完全关掉就显式写 `enabled: false`（或把两个 scale 都设成 1）。
 */
export function normalizeWakeTimeScaleConfig(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const sleepRaw = (src.sleep && typeof src.sleep === 'object' && !Array.isArray(src.sleep)) ? src.sleep : {};
  const peakRaw = (src.dsPeak && typeof src.dsPeak === 'object' && !Array.isArray(src.dsPeak)) ? src.dsPeak : {};
  const startHour = clampInt(sleepRaw.startHour, 0, 23, WAKE_TIME_SCALE_DEFAULTS.sleep.startHour);
  let endHour = clampInt(sleepRaw.endHour, 0, 23, WAKE_TIME_SCALE_DEFAULTS.sleep.endHour);
  // 起止相同等价于"没有窗口"，这几乎一定是配置笔误（例如把 0–8 写成 8–8），
  // 与其静默变成"永不生效"，不如退回默认并让调用方在日志里看到诊断。
  const sleepDegenerate = startHour === endHour;
  if (sleepDegenerate) endHour = WAKE_TIME_SCALE_DEFAULTS.sleep.endHour;
  return {
    enabled: src.enabled !== false,
    sleep: {
      enabled: sleepRaw.enabled !== false,
      startHour: sleepDegenerate ? WAKE_TIME_SCALE_DEFAULTS.sleep.startHour : startHour,
      endHour,
      scale: clampScale(sleepRaw.scale, WAKE_TIME_SCALE_DEFAULTS.sleep.scale),
      degenerate: sleepDegenerate,
    },
    dsPeak: {
      enabled: peakRaw.enabled !== false,
      scale: clampScale(peakRaw.scale, WAKE_TIME_SCALE_DEFAULTS.dsPeak.scale),
    },
  };
}

/**
 * 小时是否落在 [start, end) 窗口内，支持跨零点（如 22 → 6）。
 * `start === end` 视为空窗口（调用方应先经 `normalizeWakeTimeScaleConfig` 归一化）。
 */
export function isHourInWindow(hour, start, end) {
  const h = clampInt(hour, 0, 23, 0);
  const s = clampInt(start, 0, 23, 0);
  const e = clampInt(end, 0, 23, 0);
  if (s === e) return false;
  if (s < e) return h >= s && h < e;
  return h >= s || h < e; // 跨零点
}

/**
 * 计算当前时刻的概率乘数。
 *
 * @param {{hour:number, isDsPeak?:boolean, hourOverride?:number}} input
 *        `hour` 是**北京时间**小时（0–23），由调用方用 `beijingParts()` 得到；
 *        本模块刻意不碰 `Date`，避免再次引入"宿主时区"这一类 bug。
 * @param {object} [rawConfig] 未归一化的 `socialV2.wakeTimeScale`
 * @returns {{scale:number, sleep:boolean, dsPeak:boolean, disabled:boolean, matches:string[]}}
 */
export function wakeTimeScale(input, rawConfig) {
  const conf = normalizeWakeTimeScaleConfig(rawConfig);
  const hour = clampInt(input?.hour, 0, 23, 0);
  const isDsPeak = input?.isDsPeak === true;
  const base = { scale: 1, sleep: false, dsPeak: false, disabled: conf.enabled !== true, matches: [] };
  if (!conf.enabled) return base;

  const inSleep = conf.sleep.enabled && isHourInWindow(hour, conf.sleep.startHour, conf.sleep.endHour);
  const inPeak = conf.dsPeak.enabled && isDsPeak;
  let scale = 1;
  const matches = [];
  if (inSleep) { scale *= conf.sleep.scale; matches.push('sleep'); }
  if (inPeak) { scale *= conf.dsPeak.scale; matches.push('dsPeak'); }
  return {
    scale: Math.min(1, Math.max(0, scale)),
    sleep: inSleep,
    dsPeak: inPeak,
    disabled: false,
    matches,
  };
}

/** 人话描述（日志/控制台用）：`DS 波峰 ×0.5`、`睡觉时段(0–8) ×0.2`，两者叠加写在一起。 */
export function describeWakeTimeScale(result, rawConfig) {
  const conf = normalizeWakeTimeScaleConfig(rawConfig);
  if (!result || result.disabled) return '不限时段';
  if (!result.matches || result.matches.length === 0) return '常规时段 ×1';
  const parts = [];
  if (result.sleep) parts.push(`睡觉时段(${conf.sleep.startHour}–${conf.sleep.endHour}点) ×${conf.sleep.scale}`);
  if (result.dsPeak) parts.push(`DS 波峰 ×${conf.dsPeak.scale}`);
  return `${parts.join(' + ')} = ×${Number(result.scale.toFixed(3))}`;
}
