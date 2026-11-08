// core/tts-voices.mjs 的回归：音色/语速/音调的归一化。
//
// 这些是**字符串协议**（拼给 edge-tts 的命令行参数），拼错不会有编译期报错：
// 要么静默退回默认音色（用户以为改成功了），要么让整条语音合成失败。
// 两个方向都不能接受，所以逐条钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TTS_DEFAULT_VOICE,
  TTS_VOICE_PRESETS,
  isValidVoiceId,
  normalizeTtsVoice,
  normalizePercentArg,
  normalizePitchArg,
  findVoicePreset,
  describeVoicePresets
} from '../src/core/tts-voices.mjs';

test('音色：空值用默认，合法值原样，拼错回落且**明确标记**', () => {
  assert.equal(normalizeTtsVoice('').voice, TTS_DEFAULT_VOICE);
  assert.equal(normalizeTtsVoice(undefined).voice, TTS_DEFAULT_VOICE);
  assert.equal(normalizeTtsVoice(undefined).fallback, false, '没传不算回落');

  assert.equal(normalizeTtsVoice('zh-CN-YunxiNeural').voice, 'zh-CN-YunxiNeural');
  assert.equal(normalizeTtsVoice('zh-CN-YunxiNeural').fallback, false);

  const bad = normalizeTtsVoice('zh-CN-XiaoxiaoNural'); // 漏了个 e
  assert.equal(bad.voice, TTS_DEFAULT_VOICE);
  assert.equal(bad.fallback, true, '拼错必须标记回落，否则调用方以为换了嗓');
  assert.match(bad.reason, /不合法/);
});

test('音色：允许预设表之外的合法音色（edge-tts 支持的语言远多于预设）', () => {
  assert.equal(normalizeTtsVoice('en-US-AriaNeural').voice, 'en-US-AriaNeural');
  assert.equal(normalizeTtsVoice('ja-JP-NanamiNeural').voice, 'ja-JP-NanamiNeural');
  assert.equal(isValidVoiceId('zh-CN-XiaoxiaoNeural'), true);
  assert.equal(isValidVoiceId('Xiaoxiao'), false, '缺语区/Neural 后缀的不是合法音色名');
  assert.equal(isValidVoiceId(''), false);
  assert.equal(isValidVoiceId('zh-CN-XiaoxiaoNeural; rm -rf /'), false, '不能把杂字符塞进命令行参数');
});

test('语速/音量：百分比归一（缺符号补 +、四舍五入、夹到安全区间）', () => {
  assert.equal(normalizePercentArg('+10%'), '+10%');
  assert.equal(normalizePercentArg('10'), '+10%');
  assert.equal(normalizePercentArg('-5.6%'), '-6%');
  assert.equal(normalizePercentArg('  +10 %  '), '+10%');
  assert.equal(normalizePercentArg('0'), '+0%');
  // 越界夹紧：edge-tts 对极端值会直接报错
  assert.equal(normalizePercentArg('999%'), '+200%');
  assert.equal(normalizePercentArg('-999%'), '-90%');
  // 非法一律返回 null（调用方据此**不传该参数**，而不是传个坏值让合成失败）
  assert.equal(normalizePercentArg('abc'), null);
  assert.equal(normalizePercentArg(''), null);
  assert.equal(normalizePercentArg(undefined), null);
  assert.equal(normalizePercentArg(null), null);
});

test('音调：Hz 归一', () => {
  assert.equal(normalizePitchArg('+5Hz'), '+5Hz');
  assert.equal(normalizePitchArg('5'), '+5Hz');
  assert.equal(normalizePitchArg('-10hz'), '-10Hz');
  assert.equal(normalizePitchArg('-999'), '-100Hz');
  assert.equal(normalizePitchArg('900'), '+100Hz');
  assert.equal(normalizePitchArg('高一点'), null);
});

test('预设表本身自洽：id 合法、无重复、默认音色在表内', () => {
  assert.ok(TTS_VOICE_PRESETS.length >= 5, '可用音色太少，切换就没意义了');
  const ids = new Set();
  for (const preset of TTS_VOICE_PRESETS) {
    assert.equal(isValidVoiceId(preset.id), true, `${preset.id} 形状不合法`);
    assert.equal(ids.has(preset.id), false, `${preset.id} 重复`);
    ids.add(preset.id);
    for (const field of ['label', 'gender', 'style', 'note']) {
      assert.equal(typeof preset[field], 'string');
      assert.ok(preset[field].length > 0, `${preset.id}.${field} 不能为空`);
    }
  }
  assert.equal(ids.has(TTS_DEFAULT_VOICE), true, '默认音色必须能在预设表里找到');
  assert.equal(findVoicePreset(TTS_DEFAULT_VOICE)?.id, TTS_DEFAULT_VOICE);
  assert.equal(findVoicePreset('en-US-AriaNeural'), null, '表外音色返回 null');
});

test('describeVoicePresets 标注当前音色，便于模型/控制台一眼看出在用什么', () => {
  const text = describeVoicePresets('zh-CN-YunxiNeural');
  assert.match(text, /zh-CN-YunxiNeural（云希/);
  assert.match(text, /←当前/);
  const lines = text.split('\n');
  assert.equal(lines.filter((l) => l.includes('←当前')).length, 1, '只能标注一个当前音色');
});
