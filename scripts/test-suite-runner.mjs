// 聚合测试的共享 runner：full / quick 同一套串行执行、超时与失败口径。
// 单独成模块是为了让 quick 复用 full 的清单与行为，而不是维护第二份循环。
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SCRIPT_TIMEOUT_MS, FULL_TESTS, QUICK_TESTS } from './test-suite-manifest.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `QQ_BRIDGE_TEST_EXCLUDE="a.mjs,b.mjs"` → ['a.mjs','b.mjs']（空/未设为空数组）。 */
export function parseExclude(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const SUITES = {
  full: { tests: FULL_TESTS, title: 'Audit suite' },
  quick: { tests: QUICK_TESTS, title: 'Quick suite' }
};

export function resolveSuite(name) {
  const suite = name === undefined ? 'full' : name;
  if (suite !== 'full' && suite !== 'quick') {
    throw new Error(`未知测试套件：${String(name)}（可用：full / quick）`);
  }
  return suite;
}

// 串行执行每个脚本；任一非零退出、启动错误或超时都按失败计数。
export function runScripts(scripts, {
  root = ROOT,
  scriptsDir = path.join(root, 'scripts'),
  timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS,
  stdio = 'inherit',
  log = console.log,
  errorLog = console.error,
  exclude = parseExclude(process.env.QQ_BRIDGE_TEST_EXCLUDE)
} = {}) {
  if (!Array.isArray(scripts) || scripts.length === 0) throw new Error('测试清单为空');
  // 显式排除（CI 上用）：只排除"需要本机 Windows / 本机 DSH 安装"的少数脚本，
  // 清单写在 .github/workflows/ci.yml 里，跑的时候把被排除的名字打出来 —— 不静默。
  const filtered = exclude.length ? scripts.filter((s) => !exclude.includes(s)) : scripts;
  // 只统计**实际命中**的排除项：env 里列了本套件里不存在的名字时，不该虚报 excluded，
  // 否则 `excluded` 的语义会从"这次少跑了几个"退化成"env 里写了几个"。
  const excludedHit = exclude.length ? scripts.filter((s) => exclude.includes(s)) : [];
  if (excludedHit.length) log(`\n[runner] 按 QQ_BRIDGE_TEST_EXCLUDE 排除 ${excludedHit.length} 项：${excludedHit.join(', ')}`);
  const excludedCount = excludedHit.length;
  scripts = filtered;
  if (scripts.length === 0) throw new Error('排除后测试清单为空');
  let failed = 0;
  for (const script of scripts) {
    log(`\nRunning ${script}`);
    const result = spawnSync(process.execPath, [path.join(scriptsDir, script)], {
      cwd: root,
      stdio,
      timeout: timeoutMs,
      env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' }
    });
    if (result.status !== 0 || result.error) {
      failed += 1;
      errorLog(`FAILED ${script}: ${result.error?.message || `exit ${result.status}`}`);
    }
  }
  return { total: scripts.length, failed, passed: scripts.length - failed, excluded: excludedCount };
}

// CLI 入口共用：选择套件、跑、打印总结、把失败/超时映射成退出码 1。
export function runSuiteCli(name = 'full', {
  tests,
  root = ROOT,
  scriptsDir = path.join(root, 'scripts'),
  timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS,
  stdio = 'inherit',
  log = console.log,
  errorLog = console.error
} = {}) {
  let suite;
  try {
    suite = resolveSuite(name);
  } catch (error) {
    console.error(error.message);
    console.error('用法：node scripts/test-audit.mjs [full|quick]；quick 也可用 npm run test:quick');
    process.exitCode = 2;
    return { suite: null, total: 0, failed: 0, passed: 0, invalid: true };
  }
  const selected = tests ?? SUITES[suite].tests;
  const result = runScripts(selected, { root, scriptsDir, timeoutMs, stdio, log, errorLog });
  log(`\n${SUITES[suite].title}: ${result.passed}/${result.total} scripts passed.`);
  process.exitCode = result.failed ? 1 : 0;
  return { suite, ...result };
}
