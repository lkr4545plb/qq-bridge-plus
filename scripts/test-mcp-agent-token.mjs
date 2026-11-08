// 守卫：MCP 工具调用桥接 API 时**必须**带 `x-agent-token` 头（或显式走 admin 通道）。
//
// 为什么值得一个独立测试：桥接的集中隔离关卡只认**请求头**里的会话令牌——
// body 里的 `token` 是给各端点自己校验用的，关卡根本不看。漏了这个头，
// 工具就会返回一句"未授权：智能体调用必须携带有效的会话令牌"，而模型看到后会
// 把它当成"功能坏了"，甚至把错误原话转发给用户（2026-11-08 真实发生过：
// 用户收到的就是这样一条机器人转述的错误）。
//
// 这类失误在新增工具时极易复发，且**运行期才暴露**，所以用静态扫描钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SRC = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');

/** 把源码按 `server.tool(` 切成一个个工具块。 */
function toolBlocks(src) {
  const blocks = [];
  const marker = 'server.tool(';
  let from = src.indexOf(marker);
  while (from !== -1) {
    const next = src.indexOf(marker, from + marker.length);
    const text = src.slice(from, next === -1 ? src.length : next);
    // 工具名取第一个字符串字面量
    const nameMatch = /server\.tool\(\s*'([^']+)'/.exec(text);
    blocks.push({ name: nameMatch ? nameMatch[1] : `(未命名@${from})`, text });
    if (next === -1) break;
    from = next;
  }
  return blocks;
}

test('每个调用 agentApi 的工具都带了 x-agent-token 头或显式 admin', () => {
  const blocks = toolBlocks(MCP_SRC);
  assert.ok(blocks.length > 30, `工具数量异常（只解析到 ${blocks.length} 个），切块逻辑可能失效`);

  const offenders = [];
  for (const { name, text } of blocks) {
    // 一个工具里可能有多处 agentApi 调用，逐个看它后面那一段
    const callRe = /agentApi\s*\(/g;
    let m;
    while ((m = callRe.exec(text)) !== null) {
      const slice = text.slice(m.index, m.index + 700);
      const hasHeader = /x-agent-token/.test(slice);
      const isAdmin = /admin:\s*true/.test(slice);
      if (!hasHeader && !isAdmin) offenders.push(name);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `以下工具调用桥接 API 时既没带 x-agent-token 头、也没走 admin 通道，会被 403：\n  ${offenders.join('\n  ')}`
  );
});

test('带的令牌必须是变量而非空串硬编码（防止占位式"修复"）', () => {
  // 形如 `'x-agent-token': ''` 的写法看着像带上了，实际过不了关卡的活跃会话校验。
  const bad = [];
  const re = /'x-agent-token'\s*:\s*(''|""|undefined|null)/g;
  let m;
  while ((m = re.exec(MCP_SRC)) !== null) {
    const line = MCP_SRC.slice(0, m.index).split('\n').length;
    bad.push(`第 ${line} 行`);
  }
  assert.deepEqual(bad, [], `存在空令牌硬编码：${bad.join('，')}`);
});
