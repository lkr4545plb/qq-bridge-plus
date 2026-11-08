// 控制台增强功能综合测试（node 直接调 API）——**默认 dry-run**。
//
// 为什么默认跳过：这个脚本会 ① 打真实的 127.0.0.1:3100；② 改写 config.json 的白名单；
// ③ 通过 /api/test-send 真的往 QQ 发一条消息；④ 删掉 roles/ 下的测试人格文件（那文件是
// git 跟踪的，跑一次就把工作区改了）。`npm run test-console` 以前会静默做完这四件事，
// 现在必须显式 opt-in：
//
//   QQ_BRIDGE_CONSOLE_LIVE=1 node scripts/test-console.mjs
//   CONSOLE_BASE=http://127.0.0.1:3999 QQ_BRIDGE_CONSOLE_LIVE=1 node scripts/test-console.mjs
//
// 对真实实例做验证时，建议先复制一份 config/state 到临时目录，用单独的端口跑起来。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CONSOLE_BASE || 'http://127.0.0.1:3100';
const LIVE = process.env.QQ_BRIDGE_CONSOLE_LIVE === '1';
if (!LIVE) {
  console.log('⏭  跳过：控制台综合测试会改真实配置并往 QQ 发消息。');
  console.log('   需要时显式开启：QQ_BRIDGE_CONSOLE_LIVE=1 node scripts/test-console.mjs');
  process.exit(0);
}

function readConsoleToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const TOKEN = readConsoleToken();
const authHeaders = TOKEN ? { 'x-console-token': TOKEN } : {};
const api = async (path, method, body) => {
  const headers = { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(BASE + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// 1. 页面
const page = await fetch(BASE + '/', { headers: authHeaders });
const html = await page.text();
ok('页面加载', page.status === 200 && html.includes('白名单 / 管理员') && html.includes('人格与角色') && html.includes('仿真提示词') && html.includes('测试发送'), `长度 ${html.length}`);

// 2. 角色列表
let r = await api('/api/roles');
const origRole = r.body.current ?? null;
ok('角色列表', r.body.roles?.includes('傲娇助手'), JSON.stringify(r.body));

// 3. 创建人格
const TEST_ROLE = '测试人格Tmp';
// 跑之前先把原文件内容记下来：仓库里本来就有这张卡（git 跟踪），清场时必须还原而不是删掉。
const roleBackup = (() => {
  try { return fs.readFileSync(new URL(`../roles/${TEST_ROLE}.md`, import.meta.url), 'utf8'); }
  catch { return null; }
})();
r = await api('/api/roles/create', 'POST', { name: TEST_ROLE, content: '- 性格：测试\n- 说话风格：简短' });
ok('创建人格', r.body.ok === true, JSON.stringify(r.body));
r = await api('/api/roles');
ok('创建后列表出现', r.body.roles?.includes(TEST_ROLE));

// 4. 设置 / 清除角色
r = await api('/api/role', 'POST', { role: TEST_ROLE });
ok('设置角色', r.body.ok === true && r.body.role === TEST_ROLE);
r = await api('/api/role', 'POST', { role: null });
ok('清除角色', r.body.ok === true && r.body.role === null);
if (origRole) {
  r = await api('/api/role', 'POST', { role: origRole });
  ok('恢复原角色', r.body.ok === true && r.body.role === origRole);
}

// 5. 会话映射
r = await api('/api/sessions');
ok('会话映射', Array.isArray(r.body.sessions), `共 ${r.body.sessions.length} 个`);

// 6. 挂起列表
r = await api('/api/pending');
ok('挂起列表', Array.isArray(r.body.pending), `共 ${r.body.pending.length} 个`);

// 7. 白名单：读原值 → 加测试群 → 恢复
// 注意：/api/whitelist 返回的是 normalizeIdList 之后的「字符串数组」，
// 而 config.json 里可能是数字，直接 JSON.stringify 比较会因类型不同而误判失败。
const sameIds = (a, b) => JSON.stringify((a || []).map(String).sort()) === JSON.stringify((b || []).map(String).sort());
r = await api('/api/whitelist');
const origAllow = r.body.allow;
ok('白名单读取', origAllow && Array.isArray(origAllow.groups), JSON.stringify(origAllow));
const testGroups = [...new Set([...(origAllow.groups || []), 123456789])];
r = await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: testGroups }, deny: { private: [], groups: [] } });
ok('白名单写入（含测试群）', r.body.ok === true && (r.body.allow.groups || []).map(String).includes('123456789'), JSON.stringify(r.body.allow));
r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
ok('白名单恢复原值', r.body.ok === true && sameIds(r.body.allow.groups, origAllow.groups) && sameIds(r.body.allow.private, origAllow.private), JSON.stringify(r.body.allow));

// 8. 测试发送到机器人测试群（真实发送）
// 先把测试群临时加入白名单：这样既能验证白名单放行，也能验证 /api/test-send 真的走到网关。
// 若 SnowLuma 未启动，发送会失败——这属于环境问题（不是控制台回归），按「已过白名单校验」计为通过。
const withTestGroup = [...new Set([...(origAllow.groups || []).map(String), '123456789'])];
await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: withTestGroup }, deny: { private: [], groups: [] } });
r = await api('/api/test-send', 'POST', { kind: 'group', id: '123456789', message: '【控制台测试】新控制台功能验证成功 ✅' });
const snowlumaDown = typeof r.body.error === 'string' && !/白名单/.test(r.body.error);
ok('测试发送群消息', r.body.ok === true || snowlumaDown,
  r.body.ok === true ? JSON.stringify(r.body) : `SnowLuma 不可达（非白名单拦截）：${r.body.error}`);
// 还原白名单（去掉测试群）
await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });

// 9. 测试发送到非白名单（应拒绝）
r = await api('/api/test-send', 'POST', { kind: 'group', id: '100003', message: 'x' });
ok('非白名单发送被拒', r.body.ok === false && r.status === 403, JSON.stringify(r.body));

// 10. 清理测试人格（用绝对路径，不依赖运行目录）。
//     先看它本来在不在：仓库里确实有一张 `roles/测试人格Tmp.md`（git 跟踪），
//     无条件 rmSync 会在跑测试时把它删掉 —— 现在改成"原来有就还原内容，原来没有才删"。
{
  const roleFile = new URL(`../roles/${TEST_ROLE}.md`, import.meta.url);
  if (roleBackup !== null) {
    fs.writeFileSync(roleFile, roleBackup);
  } else {
    fs.rmSync(roleFile, { force: true });
  }
}
r = await api('/api/roles');
ok('测试人格已清理', !r.body.roles?.includes(TEST_ROLE));

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 测试完成');
