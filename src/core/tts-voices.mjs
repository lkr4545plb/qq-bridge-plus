// TTS 音色目录与归一化 —— 纯数据 + 纯函数，无 IO，可离线单测。
//
// 为什么要单独一个模块：音色名（`zh-CN-XiaoxiaoNeural` 这类）是**外部系统**（edge-tts /
// 微软 Azure 语音）的标识符，拼错不会报错，只会合成失败或退回默认音色。把它集中在这里
// 归一化，比散落在端点/工具/配置三处各写一遍正则要可靠。
//
// 语速/音调/音量也在这里归一：它们和音色属于同一层"合成参数"，一起管才不会出现
// "音色改了但音调还是上一套"的半吊子状态。

/**
 * edge-tts 音色名的形状：
 *   · 常规 `zh-CN-XiaoxiaoNeural`、`en-US-AriaNeural`
 *   · 方言音色多一段（`zh-CN-liaoning-XiaobeiNeural`、`zh-CN-shaanxi-XiaoniNeural`）
 * 只允许字母数字与连字符 —— 这个值会被拼进 spawn 的参数数组（不经 shell），
 * 但仍然不允许出现空格/引号/分号之类，免得以后有人改成 shell 调用时留下注入面。
 */
const VOICE_ID_RE = /^[a-z]{2,3}-[A-Za-z]{2,4}-(?:[a-z]{3,16}-)?[A-Za-z0-9]+Neural$/;

/** 默认音色：温暖女声，日常对话最稳。 */
export const TTS_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/**
 * 常用中文音色预设。`id` 直接就是 edge-tts 的音色名。
 * 这里只收录"确实常用、听感有区分度"的几个；用户仍可传列表外的合法音色名。
 */
export const TTS_VOICE_PRESETS = Object.freeze([
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓', gender: '女', style: '温暖亲和', note: '默认。语气自然，适合日常闲聊' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊', gender: '女', style: '活泼少女', note: '更年轻、更有起伏，适合撒娇/情绪化表达' },
  { id: 'zh-CN-YunxiNeural', label: '云希', gender: '男', style: '阳光少年', note: '清亮男声，适合轻松对话' },
  { id: 'zh-CN-YunjianNeural', label: '云健', gender: '男', style: '低沉磁性', note: '偏低沉，适合认真说话/读长句' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏', gender: '男', style: '少年感', note: '偏幼的男声，适合玩笑/吐槽' },
  { id: 'zh-CN-YunyangNeural', label: '云扬', gender: '男', style: '新闻播报', note: '标准播音腔，适合念事实/清单' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北', gender: '女', style: '东北口音', note: '带东北味，适合逗趣' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮', gender: '女', style: '陕西口音', note: '带陕西味，适合逗趣' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼', gender: '女', style: '粤语', note: '粤语女声' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻', gender: '女', style: '台湾国语', note: '台湾腔女声' }
]);

/** 音色 id → 预设（找不到返回 null，表示"合法的非预设音色"）。 */
export function findVoicePreset(id) {
  const key = String(id ?? '').trim();
  if (!key) return null;
  return TTS_VOICE_PRESETS.find((v) => v.id === key) ?? null;
}

/** 是不是一个形状合法的音色名（不校验它在不在 edge-tts 的目录里）。 */
export function isValidVoiceId(id) {
  return VOICE_ID_RE.test(String(id ?? '').trim());
}

/**
 * 归一化音色：
 *  · 空/非法 → 回默认（**不抛错**：音色是锦上添花，不该因为一个拼写错误让整条语音发不出去）；
 *  · 合法 → 原样返回（允许列表外的音色，edge-tts 支持的语言比预设表多得多）。
 * @returns {{voice: string, fallback: boolean, reason: string|null}}
 */
export function normalizeTtsVoice(raw, fallback = TTS_DEFAULT_VOICE) {
  const key = String(raw ?? '').trim();
  if (!key) return { voice: fallback, fallback: false, reason: null };
  if (isValidVoiceId(key)) return { voice: key, fallback: false, reason: null };
  return { voice: fallback, fallback: true, reason: `音色名不合法（${key.slice(0, 40)}），已用默认 ${fallback}` };
}

/** 语速/音调/音量：edge-tts 的写法是带符号百分比，如 `+10%`、`-5Hz`、`+0%`。 */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * 归一化百分比类参数（rate / volume）。接受 `10`、`"+10%"`、`"-20 %"`。
 * @returns {string|null} 合法时返回 `+10%` 形式；不合法返回 null（调用方据此不传该参数）。
 */
export function normalizePercentArg(raw, { min = -90, max = 200 } = {}) {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = String(raw).trim().replace(/\s+/g, '');
  const match = /^([+-]?\d+(?:\.\d+)?)%?$/.exec(text);
  if (!match) return null;
  const value = clamp(Number(match[1]), min, max);
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return `${rounded >= 0 ? '+' : '-'}${Math.abs(rounded)}%`;
}

/**
 * 归一化音调（pitch）。edge-tts 用 Hz，如 `+5Hz` / `-10Hz`。
 * @returns {string|null}
 */
export function normalizePitchArg(raw, { min = -100, max = 100 } = {}) {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = String(raw).trim().replace(/\s+/g, '');
  const match = /^([+-]?\d+(?:\.\d+)?)(?:hz)?$/i.exec(text);
  if (!match) return null;
  const value = clamp(Number(match[1]), min, max);
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return `${rounded >= 0 ? '+' : '-'}${Math.abs(rounded)}Hz`;
}

/** 给模型/控制台看的音色清单（纯文本，一行一个）。 */
export function describeVoicePresets(current = TTS_DEFAULT_VOICE) {
  const lines = TTS_VOICE_PRESETS.map((v) => {
    const mark = v.id === current ? ' ←当前' : '';
    return `- ${v.id}（${v.label}·${v.gender}·${v.style}）：${v.note}${mark}`;
  });
  return lines.join('\n');
}
