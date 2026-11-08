// ESLint 扁平配置 —— **只开「抓 bug」的规则**，不掺风格（风格会淹没真问题，
// 也会在 76k 行存量代码上一次性刷出几千条噪声）。
//
// 为什么必须有这一层：本仓库此前没有任何静态检查，而 `node --check` 抓不到
// 作用域错误。2026-10-24 的评审用这套规则一次扫出 14 处真实运行期 ReferenceError
// （其中一处让 `/reset` 管理命令整段失效、另一处让每条失败的发送都崩进外层 catch）。
//
// 规则分两档：
//   · error —— 一定是 bug，必须修（no-undef / 不可达 / 类型比较写错…）；
//   · warn  —— 噪声与已知豁免（重复键是刻意写法、Promise executor 返回值是既有风格…）。
// `npm run lint` 只以 error 判失败，warn 留作提示。
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'public/**',      // 控制台是单文件内联 SPA，由 test-console-static 守
      'state/**',
      'audio/**',
      '**/*.min.js',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.builtin },
    },
    rules: {
      // ── error：确定是 bug ───────────────────────────────────────────
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-obj-calls': 'error',
      'no-sparse-arrays': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-loss-of-precision': 'error',
      'no-async-promise-executor': 'error',

      // ── warn：噪声 / 既有刻意写法 ────────────────────────────────────
      // runtime-config 的 `collect` 出现两次是刻意的（第二次写在 spread 之后，
      // 用来把被 input 覆盖掉的默认值合回来），见该处注释。
      'no-dupe-keys': 'warn',
      'no-promise-executor-return': 'warn',
      'no-unmodified-loop-condition': 'warn', // 条件变量在闭包里被改写，静态判不出来
      'require-atomic-updates': 'warn',
      'no-useless-catch': 'warn',
      'no-template-curly-in-string': 'warn',
    },
  },
  {
    // 测试夹具里 `no-sparse-arrays`（空位数组）与 `no-self-compare`（`x !== x` 测 NaN）
    // 往往是**故意**的输入构造，不是 bug；生产代码（src/）仍按 error 管。
    files: ['scripts/**/*.mjs', 'scripts/fixtures/**/*.mjs'],
    rules: {
      'no-sparse-arrays': 'off',
      'no-self-compare': 'off',
    },
  },
  {
    // 控制台 UI 测试跑在 Playwright 的 page.evaluate 里，用的是浏览器全局。
    files: ['scripts/test-console-ui.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
];
