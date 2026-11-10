#!/usr/bin/env node
// 恢复被归档的 DSH 会话并重新绑定到 QQ 会话 key（2026-11-10 事故善后）。
//
// 为什么需要：会话绑定迁移把旧会话归档后，上下文原本可以继续 —— DSH 的归档只是
// 「隐藏」，`workspace/unarchiveSession` 可以恢复。本脚本：
//   1) 用 config.json 的 dsh 连接参数直连 DSH，逐个 unarchive；
//   2) 把 key → sessionId 写回 state/sessions.json（绑定默认关闭时桥接不会再次退役）。
//
// 用法：
//   node scripts/restore-session.mjs private:1159577907 session-2835e614-6f72-4106-9259-967abbf47efa
//   node scripts/restore-session.mjs --dry private:1159577907 session-...   （只查不写）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient } from '../src/dsh-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'state', 'sessions.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const rest = args.filter((a) => !a.startsWith('--'));
if (rest.length !== 2) {
  console.error('用法：node scripts/restore-session.mjs [--dry] <key> <sessionId>');
  process.exit(2);
}
const [key, sessionId] = rest;
if (!/^(group|private):\d{1,20}$/.test(key)) {
  console.error(`key 非法：${key}`);
  process.exit(2);
}
if (!/^session-[0-9a-f-]{8,}$|^qqb-[gp]-\d{1,20}-[0-9a-f]{32}$/.test(sessionId)) {
  console.error(`sessionId 非法：${sessionId}`);
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const baseUrl = String(cfg.dsh?.baseUrl || 'http://127.0.0.1:3080');
const authToken = cfg.dsh?.authToken || undefined;

const readState = () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { sessions: {}, sessionPolicies: {} }; }
};
const writeState = (state) => {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};

async function main() {
  const api = new NodeApiClient(baseUrl, undefined, authToken ? { authToken } : undefined);
  try {
    console.log(`[restore] DSH=${baseUrl} 会话=${sessionId} → ${key}`);
    if (!dry) {
      try {
        const res = await api.callUnary('workspace/unarchiveSession', { sessionId });
        console.log('[restore] unarchive 返回：', JSON.stringify(res?.unarchivedSessionIds ?? res ?? {}));
      } catch (error) {
        const msg = String(error?.message ?? error);
        // 未归档/不存在都按需继续（幂等）：只有鉴权/网络类错误才中止。
        if (!/not.?found|unknown|archived|invalid server-response/i.test(msg)) throw error;
        console.log(`[restore] unarchive 跳过（${msg.slice(0, 120)}）`);
      }
    } else {
      console.log('[restore] --dry：不调用 unarchive');
    }
    const state = readState();
    state.sessions = state.sessions && typeof state.sessions === 'object' ? state.sessions : {};
    state.sessionPolicies = state.sessionPolicies && typeof state.sessionPolicies === 'object' ? state.sessionPolicies : {};
    if (!dry) {
      state.sessions[key] = sessionId;
      writeState(state);
      console.log(`[restore] 已写回映射 ${key} → ${sessionId}`);
    }
    console.log('[restore] 完成。重启桥接后该会话继续使用原上下文。');
  } finally {
    try { api.close?.(); } catch {}
  }
}

main().catch((error) => {
  console.error('[restore] 失败：', error?.message ?? error);
  process.exit(1);
});
