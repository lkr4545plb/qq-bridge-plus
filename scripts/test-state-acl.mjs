// state/ ACL 收紧逻辑的直测（**纯函数驱动，不执行 icacls、不依赖 Windows**）。
//
// 为什么这个文件必须存在
// ----------------------
// 这段逻辑的三个历史 bug 都是"跑在 Windows 上、判错了却没人发现"：
//   ① `(OI)(CI)` 套到 /T 的文件上 → 子文件 DACL 被清空；
//   ② 自检用 `/\(I\)/` 扫全文 → 被 Low 完整性标签的 (I) 误判 → 每次启动重跑破坏性命令；
//   ③ 失败判定只认英文 `access is denied` → 中文 Windows 输出「拒绝访问」时不匹配 →
//      返回 `ok: true` → 控制台显示"已收紧"，而 console-token / accessToken / agentToken
//      仍对本机任意已登录用户可读（**假安全**）。
//
// ① 和 ② 可以靠读代码发现；③ 只能在中文系统上撞见，或者——把判定抽成纯函数后在这里钉住。
// 本文件全部用假的 `spawnSync` 返回值与注入的执行器驱动，所以在 Linux CI 上也能跑，
// 而且永远不会真的改任何 ACL。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ADMIN_SID,
  CREDENTIAL_SELF_CHECK_FILES,
  PERMISSIVE_SIDS,
  SYSTEM_SID,
  buildDirHardenSteps,
  buildFileHardenArgs,
  classifyIcaclsOutput,
  findPermissiveTrustees,
  hardenDir,
  hardenFile,
  hasInheritedPermissionAce,
  hasPermissiveTrustee,
  isHardened,
  manualDirCommand,
  verifyCredentialReadable,
} from '../src/state-acl.mjs';

/** 造一个临时目录，用完删掉（测试产物一律不落仓库 state/）。 */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-state-acl-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

/** 假的 icacls 返回值。 */
const okRun = (stdout = '已成功处理 1 个文件；处理 0 个文件时失败。\n') => ({ status: 0, stdout, stderr: '', error: null });
const deniedRun = (text = '拒绝访问。\n已成功处理 0 个文件；处理 1 个文件时失败。\n') => ({ status: 0, stdout: text, stderr: '', error: null });

// ── ① 输出分类：五种必需输入 ───────────────────────────────────────────────
test('classifyIcaclsOutput：英文成功 → ok', () => {
  const cls = classifyIcaclsOutput({ stdout: 'Successfully processed 1 files; Failed processing 0 files', stderr: '', status: 0 });
  assert.equal(cls.ok, true);
  assert.equal(cls.reason, 'ok');
  assert.equal(cls.denied, false);
});

test('classifyIcaclsOutput：英文拒绝 → denied（退出码 0 也要判失败）', () => {
  const cls = classifyIcaclsOutput({ stdout: 'Access is denied.\n', stderr: '', status: 0 });
  assert.equal(cls.ok, false);
  assert.equal(cls.reason, 'denied');
  assert.equal(cls.denied, true);
  assert.match(cls.detail, /权限不足/);
});

test('classifyIcaclsOutput：中文「拒绝访问」→ denied —— 这就是 P1 的正题', () => {
  // 中文 Windows 的真实输出形态：退出码 0（/C 的语义），只有文本能看出失败。
  const cls = classifyIcaclsOutput(deniedRun());
  assert.equal(cls.ok, false, '中文输出必须判失败，否则就是"假安全"');
  assert.equal(cls.reason, 'denied');
  assert.equal(cls.denied, true);
  assert.match(cls.detail, /拒绝访问/);
  assert.match(cls.tail, /拒绝访问/);
});

test('classifyIcaclsOutput：stderr 有报错 → 失败', () => {
  const cls = classifyIcaclsOutput({ stdout: '', stderr: 'ERROR: 参数无效\n', status: 0 });
  assert.equal(cls.ok, false);
  assert.equal(cls.reason, 'stderr');
});

test('classifyIcaclsOutput：退出码非 0 → 失败', () => {
  const cls = classifyIcaclsOutput({ stdout: '', stderr: '', status: 5 });
  assert.equal(cls.ok, false);
  assert.equal(cls.reason, 'exit-code');
  assert.match(cls.detail, /5/);
});

test('classifyIcaclsOutput：进程没起来 → spawn-error，并带上原始 message', () => {
  const err = Object.assign(new Error('spawn icacls EPERM'), { code: 'EPERM' });
  const cls = classifyIcaclsOutput({ error: err, stdout: '', stderr: '' });
  assert.equal(cls.ok, false);
  assert.equal(cls.reason, 'spawn-error');
  assert.match(cls.detail, /EPERM/);
});

test('classifyIcaclsOutput：被信号终止（status 为 null）→ 失败，不是"成功"', () => {
  const cls = classifyIcaclsOutput({ stdout: '', stderr: '', status: null, signal: 'SIGTERM' });
  assert.equal(cls.ok, false);
  assert.equal(cls.reason, 'signal');
  assert.match(cls.detail, /SIGTERM/);
});

test('classifyIcaclsOutput：`exitCode` 别名同样生效（Node 18+）', () => {
  const cls = classifyIcaclsOutput({ stdout: '', stderr: '', exitCode: 2 });
  assert.equal(cls.ok, false);
  assert.equal(cls.reason, 'exit-code');
});

test('classifyIcaclsOutput：tail 取最后 3 个非空行（既有排障线索不能丢）', () => {
  // 空行要被跳过：icacls 的换行风格在不同版本上不一致。
  const cls = classifyIcaclsOutput({ stdout: '第1行\n\n第2行\n第3行\n\n第4行\n第5行\n', stderr: '', status: 0 });
  assert.equal(cls.tail, '第3行 / 第4行 / 第5行');
  assert.equal(cls.ok, true, '这段输出里没有"拒绝访问"，属于成功');
});

test('classifyIcaclsOutput：其它语言的"拒绝访问"也不漏（de / ja / fr）', () => {
  for (const text of ['Zugriff verweigert', 'アクセスが拒否されました。', 'Accès refusé.']) {
    const cls = classifyIcaclsOutput({ stdout: `${text}\n`, stderr: '', status: 0 });
    assert.equal(cls.ok, false, `${text} 应判失败`);
    assert.equal(cls.reason, 'denied');
  }
});

test('classifyIcaclsOutput：空输出 + 退出码 0 → ok（icacls /Q 正常静默）', () => {
  const cls = classifyIcaclsOutput({ stdout: '', stderr: '', status: 0 });
  assert.equal(cls.ok, true);
  assert.equal(cls.tail, '');
});

test('classifyIcaclsOutput：脏参数不抛错（null/undefined/字符串都能吃）', () => {
  for (const bad of [null, undefined, {}, 'x', 0]) {
    const cls = classifyIcaclsOutput(bad);
    assert.equal(typeof cls.ok, 'boolean');
    assert.equal(typeof cls.tail, 'string');
  }
});

// ── ② 宽松主体识别（英文 / 中文 / SID 三种形态）────────────────────────────
test('hasPermissiveTrustee：Authenticated Users / BUILTIN\\Users / Everyone 都识别', () => {
  assert.equal(hasPermissiveTrustee('NT AUTHORITY\\Authenticated Users:(I)(M)'), true);
  assert.equal(hasPermissiveTrustee('BUILTIN\\Users:(I)(RX)'), true);
  assert.equal(hasPermissiveTrustee('Everyone:(I)(F)'), true);
});

test('hasPermissiveTrustee：中文显示名与 SID 形态也识别', () => {
  assert.equal(hasPermissiveTrustee('NT AUTHORITY\\经过验证的用户:(I)(M)'), true);
  assert.equal(hasPermissiveTrustee('S-1-5-11:(I)(M)'), true);
  assert.equal(hasPermissiveTrustee('*S-1-5-32-545:(OI)(CI)(RX)'), true);
  assert.equal(hasPermissiveTrustee('S-1-1-0:(F)'), true);
});

test('hasPermissiveTrustee：收紧后的输出不应命中（只留属主/SYSTEM/Administrators）', () => {
  const hardened = [
    'DESKTOP-1\\alice:(OI)(CI)(F)',
    'NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
    'BUILTIN\\Administrators:(OI)(CI)(F)',
    'Mandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)',
  ].join('\n');
  assert.equal(hasPermissiveTrustee(hardened), false);
  assert.deepEqual(findPermissiveTrustees(hardened), []);
});

test('findPermissiveTrustees：报出命中的是谁（告警要说清"谁还能读"）', () => {
  const out = 'NT AUTHORITY\\Authenticated Users:(I)(M)\nBUILTIN\\Users:(I)(RX)\nS-1-1-0:(F)';
  const found = findPermissiveTrustees(out);
  assert.ok(found.includes('Authenticated Users'));
  assert.ok(found.includes('BUILTIN\\Users'));
  assert.ok(found.length >= 3, `实际 ${JSON.stringify(found)}`);
});

// ── ③ 继承 ACE 判定：Mandatory Label 行必须排除 ────────────────────────────
test('hasInheritedPermissionAce：真实继承 ACE 命中，Mandatory Label 的 (I) 不算', () => {
  assert.equal(hasInheritedPermissionAce('DESKTOP-1\\alice:(I)(F)'), true);
  // DSH 沙箱给工作区打 Low 标签后，这一行永远带 (I) —— 误判会导致每次启动重跑破坏性命令
  assert.equal(hasInheritedPermissionAce('Mandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)'), false);
  assert.equal(hasInheritedPermissionAce('强制标签\\低强制级别:(I)(OI)(CI)(NW)'), false);
  assert.equal(hasInheritedPermissionAce(''), false);
});

// ── ④ 授权对象：well-known SID，不是本地化会变的显示名 ─────────────────────
test('buildDirHardenSteps：四步齐全，授权用 SID、删除用 SID', () => {
  const steps = buildDirHardenSteps('C:\\repo\\state', { user: 'alice' });
  assert.equal(steps.length, 4, '四步顺序不能变');

  // 第 1 步只断根继承（不能带 /T，否则会把 (OI)(CI) 套到文件上）
  assert.deepEqual(steps[0], ['C:\\repo\\state', '/inheritance:r', '/C', '/Q']);

  // 第 2 步按 SID 删宽松主体
  assert.ok(steps[1].includes('/remove:g'));
  for (const sid of PERMISSIVE_SIDS) assert.ok(steps[1].includes(sid), `缺 ${sid}`);

  // 第 3、4 步的授权对象必须是 SID；当前用户仍用名字
  const flat = steps.flat().join(' ');
  assert.ok(flat.includes(ADMIN_SID), `缺 Administrators SID：${ADMIN_SID}`);
  assert.ok(flat.includes(SYSTEM_SID), `缺 SYSTEM SID：${SYSTEM_SID}`);
  assert.ok(flat.includes('alice:F'));
  assert.ok(flat.includes('alice:(OI)(CI)F'), '第 4 步要给目录补可继承 ACE');

  // 绝不能出现会被本地化的显示名（中文 Windows 上解析失败 = 静默少授一条权）
  const grantArgs = steps.slice(2).flat();
  assert.ok(!grantArgs.includes('Administrators:F'), '不许再用英文组名');
  assert.ok(!grantArgs.includes('SYSTEM:F'), '不许再用英文组名');
  assert.equal(ADMIN_SID, '*S-1-5-32-544');
  assert.equal(SYSTEM_SID, '*S-1-5-18');
});

test('buildFileHardenArgs：文件不带 (OI)(CI)，授权同样用 SID', () => {
  const args = buildFileHardenArgs('C:\\repo\\config.json', { user: 'alice' });
  assert.equal(args[0], 'C:\\repo\\config.json');
  assert.ok(args.includes('/inheritance:r'));
  assert.ok(args.includes(`${ADMIN_SID}:F`));
  assert.ok(args.includes(`${SYSTEM_SID}:F`));
  assert.ok(!args.some((a) => a.includes('(OI)(CI)')), '文件不能带目录专用标志');
  assert.ok(!args.includes('Administrators:F'));
});

test('buildDirHardenSteps / buildFileHardenArgs：缺 user 直接抛（不给静默的坏参数）', () => {
  assert.throws(() => buildDirHardenSteps('d', {}), /user/);
  assert.throws(() => buildFileHardenArgs('f', {}), /user/);
});

test('manualDirCommand：Windows 分支打印的命令也用 SID，POSIX 分支仍是 chmod', () => {
  const win = manualDirCommand('C:\\repo\\state', { platform: 'win32' });
  assert.ok(win.includes(ADMIN_SID));
  assert.ok(win.includes(SYSTEM_SID));
  assert.ok(win.includes('%USERNAME%:F'));
  assert.ok(win.includes('(OI)(CI)F'), '要给目录补可继承 ACE');
  // 安全版式：目录专用标志不能和 /T 出现在同一句
  for (const line of win.split(/\n\s+/)) {
    if (line.includes('(OI)(CI)')) assert.ok(!line.includes('/T'), `危险组合：${line}`);
  }
  assert.match(manualDirCommand('C:\\repo\\state', { platform: 'linux' }), /^chmod -R go-rwx/);
});

// ── ⑤ isHardened 语义 ─────────────────────────────────────────────────────
test('isHardened：Windows 分支用注入的执行器判定（继承 ACE / 宽松主体 / 失败三条）', () => {
  const hardenedOut = 'alice:(OI)(CI)(F)\nNT AUTHORITY\\SYSTEM:(OI)(CI)(F)\nBUILTIN\\Administrators:(OI)(CI)(F)';
  const run = (out) => () => ({ status: 0, stdout: out, stderr: '', error: null });

  assert.equal(isHardened('x', { platform: 'win32', runIcacls: run(hardenedOut) }), true);

  // 还有继承 ACE → 未收紧
  assert.equal(isHardened('x', { platform: 'win32', runIcacls: run(`${hardenedOut}\nalice:(I)(F)`) }), false);
  // 还有宽松主体 → 未收紧
  assert.equal(isHardened('x', { platform: 'win32', runIcacls: run(`${hardenedOut}\nNT AUTHORITY\\Authenticated Users:(I)(M)`) }), false);
  // 读不出来 → fail-closed（不能把"不知道"当成"已收紧"）
  assert.equal(isHardened('x', { platform: 'win32', runIcacls: () => ({ status: 5, stdout: '', stderr: '' }) }), false);
  assert.equal(isHardened('x', { platform: 'win32', runIcacls: () => ({ status: 0, stdout: '拒绝访问。', stderr: '', error: null }) }), false);
  assert.equal(isHardened('x', { platform: 'win32', runIcacls: () => ({ error: new Error('EPERM'), stdout: '', stderr: '' }) }), false);
});

test('isHardened：POSIX 分支只看目标自身 mode（700/600 为已收紧）', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t);
  fs.chmodSync(dir, 0o700);
  assert.equal(isHardened(dir), true);
  fs.chmodSync(dir, 0o755);
  assert.equal(isHardened(dir), false);

  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, 'x');
  fs.chmodSync(file, 0o600);
  assert.equal(isHardened(file), true);
  fs.chmodSync(file, 0o644);
  assert.equal(isHardened(file), false);

  assert.equal(isHardened(path.join(dir, '不存在')), false, '不存在的路径不能算已收紧');
});

// ── ⑥ 收紧后的读取自检（可注入，不碰真实 ACL）─────────────────────────────
test('verifyCredentialReadable：没有凭据文件时跳过而非失败', () => {
  const r = verifyCredentialReadable({ dir: '/tmp/x', exists: () => false, readFile: () => '' });
  assert.equal(r.ok, true);
  assert.equal(r.checked, null);
  assert.match(r.detail, /跳过/);
});

test('verifyCredentialReadable：优先读 console-token，读成功即 ok', () => {
  const seen = [];
  const r = verifyCredentialReadable({
    dir: '/tmp/x',
    exists: (file) => file.endsWith('console-token') || file.endsWith('bridge.lock'),
    readFile: (file) => { seen.push(file); return 'token'; },
  });
  assert.equal(r.ok, true);
  assert.ok(r.checked.endsWith(CREDENTIAL_SELF_CHECK_FILES[0]));
  assert.deepEqual(seen, [r.checked], '只读一次，且只读第一个存在的候选');
});

test('verifyCredentialReadable：目录里只有 bridge.lock 时退到它', () => {
  const r = verifyCredentialReadable({
    dir: '/tmp/x',
    exists: (file) => file.endsWith('bridge.lock'),
    readFile: () => '1234',
  });
  assert.equal(r.ok, true);
  assert.ok(r.checked.endsWith('bridge.lock'));
});

test('verifyCredentialReadable：读失败 → ok:false 并带上原因（这是"把 DACL 清空"的探测器）', () => {
  const r = verifyCredentialReadable({
    dir: '/tmp/x',
    exists: () => true,
    readFile: () => { throw Object.assign(new Error('Access is denied.'), { code: 'EPERM' }); },
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /denied/i);
  assert.ok(r.checked.includes('console-token'));
});

test('verifyCredentialReadable：exists 抛错不炸（当成不存在继续往下找）', () => {
  const r = verifyCredentialReadable({
    dir: '/tmp/x',
    exists: (file) => { if (file.endsWith('console-token')) throw new Error('stat failed'); return file.endsWith('sessions.json'); },
    readFile: () => '{}',
  });
  assert.equal(r.ok, true);
  assert.ok(r.checked.endsWith('sessions.json'));
});

// ── ⑦ hardenDir / hardenFile 的 Windows 分支（注入假执行器，端到端）────────
test('hardenDir：中文「拒绝访问」→ ok:false，且报出是第几步', () => {
  const r = hardenDir('C:\\repo\\state', {
    platform: 'win32',
    env: { USERNAME: 'alice' },
    runIcacls: () => deniedRun(),
    verify: () => ({ ok: true, checked: null, detail: '' }),
  });
  assert.equal(r.ok, false, '中文输出必须判失败');
  assert.equal(r.step, 1);
  assert.match(r.detail, /拒绝访问|权限不足/);
});

test('hardenDir：英文拒绝同样失败（两种语言走同一条判定）', () => {
  const r = hardenDir('C:\\repo\\state', {
    platform: 'win32',
    env: { USERNAME: 'alice' },
    runIcacls: () => ({ status: 0, stdout: 'Access is denied.\n', stderr: '', error: null }),
    verify: () => ({ ok: true, checked: null, detail: '' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.step, 1);
});

test('hardenDir：第 3 步失败要在 step 上报出来（不是笼统的"失败"）', () => {
  let call = 0;
  const r = hardenDir('C:\\repo\\state', {
    platform: 'win32',
    env: { USERNAME: 'alice' },
    runIcacls: () => { call += 1; return call === 3 ? deniedRun() : okRun(); },
    verify: () => ({ ok: true, checked: null, detail: '' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.step, 3);
});

test('hardenDir：四步都成功且自检可读 → ok', () => {
  const calls = [];
  const r = hardenDir('C:\\repo\\state', {
    platform: 'win32',
    env: { USERNAME: 'alice' },
    runIcacls: (args) => { calls.push(args); return okRun(); },
    verify: ({ dir }) => { assert.equal(dir, 'C:\\repo\\state'); return { ok: true, checked: 'console-token', detail: '可读' }; },
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 4);
});

test('hardenDir：命令都成功但凭据读不出来 → 仍然 ok:false（防"把 DACL 清空"）', () => {
  const r = hardenDir('C:\\repo\\state', {
    platform: 'win32',
    env: { USERNAME: 'alice' },
    runIcacls: () => okRun(),
    verify: () => ({ ok: false, checked: 'C:\\repo\\state\\console-token', detail: 'Access is denied.' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /无法读取/);
  assert.match(r.detail, /console-token/);
});

test('hardenDir：拿不到 USERNAME → 明确失败，不发半截命令', () => {
  let called = 0;
  const r = hardenDir('C:\\repo\\state', {
    platform: 'win32',
    env: {},
    runIcacls: () => { called += 1; return okRun(); },
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /USERNAME/);
  assert.equal(called, 0);
});

test('hardenFile：Windows 分支同样按文本判定成功/失败', () => {
  const ok = hardenFile('C:\\repo\\config.json', {
    platform: 'win32', env: { USERNAME: 'alice' }, runIcacls: () => okRun(),
  });
  assert.equal(ok.ok, true);

  const bad = hardenFile('C:\\repo\\config.json', {
    platform: 'win32', env: { USERNAME: 'alice' }, runIcacls: () => deniedRun(),
  });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /拒绝访问|权限不足/);
});

// ── ⑧ POSIX 分支不受影响（本机 Linux 上真实执行 chmod）────────────────────
test('hardenDir / hardenFile：非 Windows 走 chmod，且真的改到了 mode', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t);
  fs.chmodSync(dir, 0o755);
  const r = hardenDir(dir);
  assert.equal(r.ok, true);
  assert.match(r.detail, /chmod 700/);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0o644);
  const rf = hardenFile(file);
  assert.equal(rf.ok, true);
  assert.match(rf.detail, /chmod 600/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('POSIX 分支不会去调 icacls（注入的执行器必须零调用）', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t);
  let called = 0;
  const r = hardenDir(dir, { runIcacls: () => { called += 1; return okRun(); } });
  assert.equal(r.ok, true);
  assert.equal(called, 0, 'Linux 上不应触碰 icacls');
});
