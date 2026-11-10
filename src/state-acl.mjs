// state/ 目录 ACL 收紧的**唯一实现**。
//
// 为什么单独成模块：这套逻辑原本在桥接进程（`src/bridge.js` 的 hardenStateDirAcl）和
// 安装脚本（`scripts/harden-state-acl.mjs`）里各写了一份，两份带着**同一个** bug：
//
//   icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /grant:r ... /T /C
//
// `(OI)(CI)` 是**目录专用**的继承标志。icacls 把它套到 `/T` 展开出来的**文件**上会失败，
// 而同一句里的 `/inheritance:r` 已经把文件原有的继承 ACE 摘掉了 —— 净结果是**子文件
// DACL 被清空，连属主自己都读不了**。实测后果：state/ 下 50 个子文件变成空 DACL，
// 桥接读不到自己的控制台令牌（"Access to the path ... is denied"），而启动日志只报
// 「未能收紧权限」，完全看不出已经造成了破坏。
//
// 第二个 bug 让第一个 bug 反复发生：回读自检用 `/\(I\)/.test(整段输出)` 判断「继承链是否
// 断干净」。但 DSH 的 ACL 沙箱会把工作区（含 state/）标记为 Low 完整性，而
// `Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)` 这一行**永远**带 (I) ——
// 于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
//
// 合并成一份实现，从结构上杜绝两份逻辑再次漂移。
//
// 正确顺序是四步，缺一不可：
//   1. 目录上停止继承；
//   2. 按 **SID** 删除宽松主体（不受系统显示语言影响）；
//   3. 对**每一个**条目显式授权 —— 不带 (OI)(CI)，所以对文件同样有效；
//   4. 给目录补一份可继承 ACE，让以后新建的文件自动拿到权限。
//
// ── 本地化（中文 Windows）修复 ──────────────────────────────────────────────
// 第三个 bug 是这次修的：**失败判定只认英文**。`icacls` 带 `/C` 时即使整体失败退出码仍是 0
// （`/C` 的语义就是"继续处理剩余文件"），所以只能靠输出文本判定；而中文 Windows 输出的是
// 「拒绝访问」，`/access is denied/i` 匹配不上 → 返回 `ok: true` → 调用方把"已收紧"显示给
// 用户，**而 state/ 里的 console-token / accessToken / 各会话 agentToken 仍对本机任意已登录
// 用户可读**。这是"假安全"，比明确失败更危险。
//
// 修法三条：
//   · 判定抽成纯函数 {@link classifyIcaclsOutput}，同时匹配英文、中文（及若干常见语言的
//     "拒绝访问"），并且**退出码非 0 / stderr 有内容也判失败**（宁可报没做成，也不要假装安全）；
//   · 授权对象改用 **well-known SID**（`*S-1-5-32-544` 等），不再依赖 `Administrators` /
//     `SYSTEM` 这些会被本地化的显示名；
//   · 收紧后的自检不再只 `readdirSync(dir)`（"目录可列"不等于"文件可读"），而是用本进程
//     真的 `readFileSync` 一个已知凭据文件（{@link verifyCredentialReadable}）。
//
// 自检与幂等：调用方应先用 {@link isHardened} 判断，**已收紧就不要重跑**（每次重跑都是几条
// `icacls /T`，在几百个文件的 state/ 上既慢又没必要）。`hardenDir` 本身刻意不做这个前置判断，
// 保持"调用即执行"的语义；`isHardened` 只读、无副作用。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ── well-known SID（与系统显示语言无关）──────────────────────────────────────
/** BUILTIN\Administrators */
export const ADMIN_SID = '*S-1-5-32-544';
/** NT AUTHORITY\SYSTEM（LOCAL SYSTEM） */
export const SYSTEM_SID = '*S-1-5-18';
/** 宽松主体：Authenticated Users / BUILTIN\Users / Everyone。 */
export const PERMISSIVE_SIDS = ['*S-1-5-11', '*S-1-5-32-545', '*S-1-1-0'];

/** 宽松主体的**显示名**（英文 + 中文），用于回读判定；SID 形式另行匹配。 */
const PERMISSIVE_TRUSTEE_NAMES = [
  'Authenticated Users',
  'BUILTIN\\Users',
  'Everyone',
  '经过验证的用户',   // zh-CN: Authenticated Users
  '驗證的使用者',     // zh-TW
  '所有人',           // Everyone 的常见中文显示名（部分本地化版本）
  'Jeder',            // de
  'Todos',            // es
  'Tout le monde',    // fr
];

/**
 * "拒绝访问"的多语言形态。**这是安全判定的核心**：
 * `icacls /C` 失败时退出码仍是 0，所以文本是唯一信号，漏一种语言就等于漏一次"假成功"。
 */
const DENIED_PATTERNS = [
  /access is denied/i,
  /\bdenied\b/i,
  /拒绝访问|访问被拒绝|拒絕存取|存取被拒/,
  /zugriff verweigert/i,       // de
  /acceso denegado/i,          // es
  /acc[eè]s refus[eé]/i,       // fr
  /アクセスが拒否されました/,     // ja
  /액세스가 거부/,               // ko
];

/**
 * 纯函数：把一次 `spawnSync('icacls', ...)` 的结果分类成"成功 / 哪种失败"。
 *
 * 为什么必须抽出来：这段判定只能在 Windows 上跑，而**判错就是假安全**。抽成纯函数后
 * 可以在 Linux CI 上把各语言的输出喂给它做断言（`scripts/test-state-acl.mjs`），
 * 不需要真的执行 icacls、也不需要一台中文 Windows。
 *
 * 判定顺序（从严到宽，先命中先返回）：
 *   ① 进程没起来（`error`）→ `spawn-error`
 *   ② 输出里出现"拒绝访问"（任意支持的语言）→ `denied`
 *   ③ 退出码非 0 → `exit-code`
 *   ④ stderr 有内容 → `stderr`
 *   ⑤ 其余 → `ok`
 *
 * ③④ 之所以也算失败：`icacls` 成功时既不会返回非 0 也不会写 stderr。收紧权限这种事
 * 宁可多报一次失败，也不能漏报。
 *
 * @param {{stdout?: string, stderr?: string, error?: Error|null, exitCode?: number|null, status?: number|null}} result
 *        `spawnSync` 的返回值；`status` 与 `exitCode` 都接受（后者是 Node 18+ 的别名）。
 * @returns {{ok: boolean, reason: string, denied: boolean, detail: string, tail: string}}
 */
export function classifyIcaclsOutput(result) {
  const res = (result && typeof result === 'object') ? result : {};
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  const combined = `${stdout}${stderr}`;
  // 末尾三行原样保留：调用方（桥接/脚本）会把它们塞进告警，是排障的唯一线索。
  const tail = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(' / ');

  if (res.error) {
    const message = res.error?.message ?? String(res.error);
    return { ok: false, reason: 'spawn-error', denied: false, detail: `无法执行 icacls：${message}`, tail };
  }

  const denied = DENIED_PATTERNS.some((re) => re.test(combined));
  if (denied) {
    return { ok: false, reason: 'denied', denied: true, detail: `icacls 报权限不足${tail ? `：${tail}` : ''}`, tail };
  }

  // 被信号杀死时 spawnSync 的 status 是 null、signal 有值 —— 那不是"成功"。
  if (res.signal) {
    return { ok: false, reason: 'signal', denied: false, detail: `icacls 被信号终止（${res.signal}）${tail ? `：${tail}` : ''}`, tail };
  }

  const exitCode = res.status !== undefined && res.status !== null ? res.status : res.exitCode;
  if (exitCode !== undefined && exitCode !== null && Number(exitCode) !== 0) {
    return { ok: false, reason: 'exit-code', denied: false, detail: `icacls 退出码 ${exitCode}${tail ? `：${tail}` : ''}`, tail };
  }

  const stderrText = stderr.trim();
  if (stderrText) {
    return { ok: false, reason: 'stderr', denied: false, detail: `icacls 写到 stderr${tail ? `：${tail}` : ''}`, tail };
  }

  return { ok: true, reason: 'ok', denied: false, detail: 'icacls 成功', tail };
}

/** icacls 的可执行封装（统一超时与隐藏窗口）。 */
export function icacls(args, timeout = 30000) {
  return spawnSync('icacls', args, { encoding: 'utf8', timeout, windowsHide: true });
}

/**
 * icacls 输出里是否还有**继承来的权限** ACE。
 *
 * 必须排除 Mandatory Label 行：那不是权限，而且 DSH 沙箱打过 Low 标签后它永远带 (I)。
 * 用全文 `/\(I\)/` 扫描会把「已收紧」判成「未收紧」，进而让调用方反复重跑破坏性命令。
 */
/**
 * 空 DACL/仅完整性标签不属于「已收紧」：至少要存在一条**实际 allow 权限**。
 * 纯函数，与 hasInheritedPermissionAce/hasPermissiveTrustee 互补（上游 24e29ba/d7fae44 的吸收项）。
 */
export function hasPermissionGrant(icaclsOutput) {
  return String(icaclsOutput ?? '').split(/\r?\n/).some((line) => {
    if (/Mandatory Label|\(DENY\)/i.test(line)) return false;
    // 必须是 trustee 冒号后的 ACE，路径名里的「(F)」不是授权。
    const ace = /:((?:\((?:I|OI|CI|IO|NP)\))*)\((?:F|M|RX|R|W|D|RC|WDAC|WO|RD|WD|AD|REA|WEA|X|DC|RA|WA)(?:,[A-Z]+)*\)/.exec(line);
    // (IO) 只对子项生效，不能证明当前目录/文件自己仍有可用权限。
    return ace !== null && !ace[1].includes('(IO)');
  });
}

export function hasInheritedPermissionAce(icaclsOutput) {
  return String(icaclsOutput ?? '')
    .split(/\r?\n/)
    .filter((line) => !/Mandatory Label|强制标签|强制標籤/i.test(line))
    .some((line) => /\(I\)/.test(line));
}

/**
 * 找出输出里出现的**宽松主体**（返回命中的名字/SID 列表，便于在告警里说清"是谁"）。
 *
 * 同时认三种形态：英文显示名、中文（及若干语言）显示名、以及 SID 字面量 ——
 * 因为 icacls 在不同系统语言/不同 `icacls` 版本下既可能显示名字，也可能直接显示 SID。
 */
export function findPermissiveTrustees(icaclsOutput) {
  const text = String(icaclsOutput ?? '');
  if (!text) return [];
  const found = new Set();
  for (const name of PERMISSIVE_TRUSTEE_NAMES) {
    // 名字里可能带反斜杠（BUILTIN\Users），按字面包含判断，不做正则转义。
    if (text.includes(name)) found.add(name);
  }
  for (const m of text.matchAll(/(\*?S-1-5-(?:11|32-545)|S-1-1-0)\b/g)) found.add(m[1]);
  // 兜底：英文大小写变体（Authenticated Users 在某些版本里全大写）。
  if (/authenticated users/i.test(text)) found.add('Authenticated Users');
  if (/\beveryone\b/i.test(text)) found.add('Everyone');
  return [...found];
}

/** 是否还有本机任意用户可读的宽松主体授权。 */
export function hasPermissiveTrustee(icaclsOutput) {
  return findPermissiveTrustees(icaclsOutput).length > 0;
}

/**
 * 收紧后自检要读的凭据文件名（按优先级）。
 *
 * 只挑**凭据类**文件：读得到它们才说明 DACL 没把属主自己锁在外面。`bridge.log` 之类
 * 不含密钥的日志故意不在列表里 —— 它可能是 644，但那不构成泄密。
 */
export const CREDENTIAL_SELF_CHECK_FILES = ['console-token', 'bridge.lock', 'sessions.json'];

/**
 * 用本进程**真的读一次**凭据文件，验证收紧没有把属主自己锁死。
 *
 * 为什么不是 `readdirSync(dir)`：目录可列（LIST）与文件可读（READ_DATA）是两条不同的 ACE，
 * 只列目录发现不了"文件 DACL 被清空"这类破坏 —— 而历史上正是这种破坏把桥接的控制台令牌
 * 读没了。凭据能力可注入，便于在 Linux 上单测（不碰真实 ACL）。
 *
 * @param {object} options
 * @param {string} options.dir 目录
 * @param {(file: string) => string|Buffer} [options.readFile] 读文件（默认 fs.readFileSync）
 * @param {(file: string) => boolean} [options.exists] 判断存在（默认 fs.existsSync）
 * @param {string[]} [options.candidates] 候选文件名（默认 {@link CREDENTIAL_SELF_CHECK_FILES}）
 * @returns {{ok: boolean, checked: string|null, detail: string}}
 */
export function verifyCredentialReadable({
  dir,
  readFile = (file) => fs.readFileSync(file),
  exists = (file) => fs.existsSync(file),
  candidates = CREDENTIAL_SELF_CHECK_FILES,
} = {}) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : CREDENTIAL_SELF_CHECK_FILES;
  const target = list
    .map((name) => path.join(dir, name))
    .find((file) => {
      try { return exists(file) === true; } catch { return false; }
    });
  if (!target) {
    // 首次启动时 state/ 里还没有任何凭据文件，无从读起 —— 这不构成失败。
    return { ok: true, checked: null, detail: '目录内尚无凭据文件，跳过读取自检' };
  }
  try {
    readFile(target);
    return { ok: true, checked: target, detail: '可读' };
  } catch (error) {
    return { ok: false, checked: target, detail: error?.message ?? String(error) };
  }
}

/**
 * 目标路径的权限是否已收紧：既没有继承来的权限 ACE，也没有宽松主体。
 *
 * **语义**（调用方据此决定"要不要跑 harden"）：
 *   · Windows：`icacls <target>` 能跑通，且输出里既无继承 ACE（排除 Mandatory Label 行）
 *     也无宽松主体（名字或 SID 任一形态）；读取失败一律视为"未收紧"（fail-closed）。
 *   · 非 Windows：只要求目标自身的 mode 不带 go 位（目录 700 / 文件 600）。目录 700 已经
 *     挡住其他用户的遍历，子树无需逐个检查。
 *
 * 只读、无副作用、不修改任何 ACL。
 * @param {string} target - 目录或文件路径。
 */
export function isHardened(target, { platform = process.platform, runIcacls = icacls } = {}) {
  if (platform !== 'win32') {
    try { return (fs.statSync(target).mode & 0o077) === 0; } catch { return false; }
  }
  const res = runIcacls([target], 10000);
  const cls = classifyIcaclsOutput(res);
  if (!cls.ok) return false;
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return !hasInheritedPermissionAce(out) && !hasPermissiveTrustee(out) && hasPermissionGrant(out);
}

/**
 * 纯函数：生成"收紧一个目录"的四步 icacls 参数。
 *
 * 授权对象用 well-known SID（`*S-1-5-32-544` = Administrators，`*S-1-5-18` = SYSTEM），
 * 当前用户仍用名字（它没有 well-known SID）。**不要**改成 `Administrators` / `SYSTEM`
 * 这类显示名：中文 Windows 上显示名会被本地化，`icacls` 解析失败就是一个静默的
 * "少授一条权"，而 `/C` 让退出码依旧是 0。
 *
 * @param {string} dir 目标目录
 * @param {{user: string, admin?: string, system?: string}} options
 * @returns {string[][]} 每一步的参数数组（不含可执行文件名）
 */
export function buildDirHardenSteps(dir, { user, admin = ADMIN_SID, system = SYSTEM_SID } = {}) {
  if (!user) throw new TypeError('buildDirHardenSteps 需要 user');
  return [
    // 1. 目录上停止继承（不带 /T：先只断根，再逐条处理子树）
    [dir, '/inheritance:r', '/C', '/Q'],
    // 2. 按 SID 删除宽松主体
    [dir, '/remove:g', ...PERMISSIVE_SIDS, '/T', '/C', '/Q'],
    // 3. 逐条目显式授权：不带 (OI)(CI)，所以对文件同样有效（这是历史 bug 的修法）
    [dir, '/T', '/C', '/Q', '/grant', `${user}:F`, '/grant', `${system}:F`, '/grant', `${admin}:F`],
    // 4. 目录本身补可继承 ACE，让以后新建的文件自动拿到权限
    [dir, '/Q', '/grant', `${user}:(OI)(CI)F`, '/grant', `${system}:(OI)(CI)F`, '/grant', `${admin}:(OI)(CI)F`],
  ];
}

/**
 * 纯函数：生成"收紧一个文件"的 icacls 参数（文件不能带 (OI)(CI)）。
 * @param {string} file 目标文件
 * @param {{user: string, admin?: string, system?: string}} options
 * @returns {string[]}
 */
export function buildFileHardenArgs(file, { user, admin = ADMIN_SID, system = SYSTEM_SID } = {}) {
  if (!user) throw new TypeError('buildFileHardenArgs 需要 user');
  return [file, '/inheritance:r',
    '/grant:r', `${user}:F`, '/grant:r', `${system}:F`, '/grant:r', `${admin}:F`, '/C', '/Q'];
}

/**
 * 收紧一个**目录**及其整棵子树的权限。
 *
 * 失败一律 `{ok:false}`，**绝不因为"命令跑完了"就报成功**：`/C` 让退出码恒为 0，
 * 所以每一步都走 {@link classifyIcaclsOutput} 看文本，最后再用
 * {@link verifyCredentialReadable} 真读一次凭据文件。
 *
 * @param {string} dir - 目标目录。
 * @returns {{ok: boolean, detail: string, step?: number}}
 */
export function hardenDir(dir, {
  platform = process.platform,
  runIcacls = icacls,
  env = process.env,
  verify = verifyCredentialReadable,
} = {}) {
  if (platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); return { ok: true, detail: 'chmod 700' }; }
    catch (error) { return { ok: false, detail: error?.message ?? String(error) }; }
  }
  const user = env.USERNAME;
  if (!user) return { ok: false, detail: '无法确定当前用户名（%USERNAME% 为空）' };
  const steps = buildDirHardenSteps(dir, { user });
  for (let i = 0; i < steps.length; i += 1) {
    const res = runIcacls(steps[i]);
    const cls = classifyIcaclsOutput(res);
    if (!cls.ok) return { ok: false, detail: `第 ${i + 1} 步失败：${cls.detail}`, step: i + 1 };
  }
  // 自检：属主必须仍能**读到凭据文件**（防止把 DACL 清空这种"成功"的破坏）。
  const selfCheck = verify({ dir });
  if (!selfCheck.ok) {
    return { ok: false, detail: `收紧后无法读取 ${selfCheck.checked}（${selfCheck.detail}），请检查 ACL` };
  }
  return { ok: true, detail: 'icacls' };
}

/**
 * 收紧一个**文件**的权限（凭据文件用；文件不能带 (OI)(CI)）。
 * @param {string} file - 目标文件。
 * @returns {{ok: boolean, detail: string}}
 */
export function hardenFile(file, { platform = process.platform, runIcacls = icacls, env = process.env } = {}) {
  if (platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); return { ok: true, detail: 'chmod 600' }; }
    catch (error) { return { ok: false, detail: error?.message ?? String(error) }; }
  }
  const user = env.USERNAME;
  if (!user) return { ok: false, detail: '无法确定当前用户名（%USERNAME% 为空）' };
  const res = runIcacls(buildFileHardenArgs(file, { user }));
  const cls = classifyIcaclsOutput(res);
  if (!cls.ok) return { ok: false, detail: cls.detail };
  return { ok: true, detail: 'icacls' };
}

/**
 * 给人看的手动收紧命令（失败降级时打印）。
 *
 * 必须是**安全**的那一版：
 *   · 把 (OI)(CI) 授权和 /T 混在同一句里会把子文件 DACL 清空；
 *   · 授权对象用 SID，避免中文 Windows 上 `Administrators` / `SYSTEM` 解析失败。
 */
export function manualDirCommand(dir, { platform = process.platform } = {}) {
  if (platform !== 'win32') return `chmod -R go-rwx "${dir}"`;
  const d = `"${dir}"`;
  const admin = `"${ADMIN_SID}:F"`;
  const adminInherit = `"${ADMIN_SID}:(OI)(CI)F"`;
  const system = `"${SYSTEM_SID}:F"`;
  const systemInherit = `"${SYSTEM_SID}:(OI)(CI)F"`;
  return [
    `icacls ${d} /inheritance:r /C /Q`,
    `icacls ${d} /remove:g ${PERMISSIVE_SIDS.map((sid) => `"${sid}"`).join(' ')} /T /C /Q`,
    `icacls ${d} /T /C /Q /grant "%USERNAME%:F" /grant ${system} /grant ${admin}`,
    `icacls ${d} /Q /grant "%USERNAME%:(OI)(CI)F" /grant ${systemInherit} /grant ${adminInherit}`,
  ].join('\n             ');
}
