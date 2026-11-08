// 本地语音转写：SILK → PCM → WAV → whisper.cpp → 文字。
//
// 为什么需要它（2026-11-08 实测）：
//   QQ 客户端自带的语音转写（`fetch_ptt_text`）在**群语音**上直接失败：
//   `ptt translate failed: error=4294966146`。而收到的语音文件是 **SILK V3**
//   （头部 `#!SILK_V3`，前面还多一个 0x02 字节），ffmpeg **不认识 SILK**。
//   所以整条链路必须自己走：silk-decoder 解成 PCM(24kHz) → ffmpeg 转 wav → whisper 转写。
//
// 实测性能（2 核 Neoverse-N1）：6.3 秒语音 → 3.2 秒转写（约 2x 实时）。
//
// 依赖放在 /opt/local-asr（**不要用 /tmp**：重启就没了）：
//   bin/silk-decoder  bin/whisper-cli  bin/lib*.so  models/ggml-base.bin
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** SILK 文件头：`#!SILK_V3`（前面可能有一个 0x02 字节）。 */
const SILK_MAGIC = Buffer.from('#!SILK_V3');

/**
 * 从缓冲里认出 SILK 并去掉前导字节。
 * @returns {{isSilk: boolean, body: Buffer}}
 */
export function stripSilkPrefix(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  // 正常形态：02 23 21 53 49 4c 4b 5f 56 33（0x02 + "#!SILK_V3"）
  if (buf.length > SILK_MAGIC.length + 1 && buf[0] === 0x02 && buf.subarray(1, 1 + SILK_MAGIC.length).equals(SILK_MAGIC)) {
    return { isSilk: true, body: buf.subarray(1) };
  }
  if (buf.length > SILK_MAGIC.length && buf.subarray(0, SILK_MAGIC.length).equals(SILK_MAGIC)) {
    return { isSilk: true, body: buf };
  }
  return { isSilk: false, body: buf };
}

/**
 * 解析 whisper-cli 的输出：去掉时间戳标记与空行。
 * 纯函数，便于离线单测。
 */
export function parseWhisperOutput(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .map((line) => line.replace(/^\[[\d:.\s\->]+\]\s*/, '').trim())
    .filter((line) => line && !/^\[BLANK_AUDIO\]$/i.test(line) && !/^\(.*\)$/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function runProcess(cmd, args, { timeoutMs = 60_000, env = null } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env ? { ...process.env, ...env } : process.env
      });
    } catch (error) {
      reject(new Error(`启动失败（${cmd}）：${error?.message ?? error}`));
      return;
    }
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`超时（${timeoutMs}ms）：${path.basename(cmd)}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${path.basename(cmd)} 不可用：${error?.message ?? error}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${(err || out).trim().slice(0, 200)}`));
    });
  });
}

/**
 * 本地转写一段语音。
 * @param {Buffer} audioBuffer - 原始语音字节（SILK 或任意 ffmpeg 认识的格式）
 * @param {object} cfg - 见 normalizeLocalAsrConfig
 * @returns {Promise<{text: string, seconds: number, ms: number}>}
 */
export async function transcribeLocally(audioBuffer, cfg = {}) {
  const started = Date.now();
  const conf = {
    silkDecoder: cfg.silkDecoder || '/opt/local-asr/bin/silk-decoder',
    whisperBin: cfg.whisperBin || '/opt/local-asr/bin/whisper-cli',
    model: cfg.model || '/opt/local-asr/models/ggml-base.bin',
    language: cfg.language || 'zh',
    ffmpeg: cfg.ffmpeg || 'ffmpeg',
    libPath: cfg.libPath || '/opt/local-asr/bin',
    timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 120_000
  };
  for (const [label, file] of [['silkDecoder', conf.silkDecoder], ['whisperBin', conf.whisperBin], ['model', conf.model]]) {
    if (!fs.existsSync(file)) throw new Error(`本地转写不可用：找不到 ${label}（${file}）`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-'));
  try {
    const { isSilk, body } = stripSilkPrefix(audioBuffer);
    let wavPath = path.join(dir, 'in.wav');
    if (isSilk) {
      const silkPath = path.join(dir, 'in.silk');
      const pcmPath = path.join(dir, 'in.pcm');
      fs.writeFileSync(silkPath, body);
      await runProcess(conf.silkDecoder, [silkPath, pcmPath], { timeoutMs: 20_000 });
      // QQ 语音固定 24kHz 单声道 16bit —— 用 16k 解会让时长算错（实测 6.34s 会变成 9.45s）
      await runProcess(conf.ffmpeg, ['-hide_banner', '-v', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, '-y', wavPath], { timeoutMs: 20_000 });
    } else {
      await runProcess(conf.ffmpeg, ['-hide_banner', '-v', 'error', '-i', 'pipe:0', '-y', wavPath], { timeoutMs: 20_000 });
      fs.writeFileSync(path.join(dir, 'raw.bin'), body);
      await runProcess(conf.ffmpeg, ['-hide_banner', '-v', 'error', '-i', path.join(dir, 'raw.bin'), '-y', wavPath], { timeoutMs: 20_000 });
    }
    const { stdout } = await runProcess(
      conf.whisperBin,
      ['-m', conf.model, '-f', wavPath, '-l', conf.language, '-nt', '--no-prints'],
      {
        timeoutMs: conf.timeoutMs,
        // whisper-cli 的共享库和它同目录，移出构建目录后必须显式指定
        env: { LD_LIBRARY_PATH: [conf.libPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
      }
    );
    return { text: parseWhisperOutput(stdout), seconds: (Date.now() - started) / 1000, ms: Date.now() - started };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
