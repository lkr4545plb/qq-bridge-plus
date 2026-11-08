#!/usr/bin/env node
// 贴吧库的**安全回归**：正则回溯的性能上界 + 图床域名白名单。
//
// 两件事都是本次审计的实测结论：
//   ① `src/tieba-lib.js` 用正则解析百度贴吧 HTML，几处在"接近但不匹配"的畸形输入上退化成 O(n²)
//      （改前：280KB 伪页面 1.8 秒、300KB 7 秒；`htmlToText` 32KB 就要 417ms、256KB 23 秒）。
//      解析是**同步跑在 bridge 事件循环上**的，一次畸形页面就能把 QQ 收发、控制台、看门狗一起卡死。
//   ② 图床白名单只在校验入口生效：`buildTiebaImageContent` 只过滤 `^https?://`，且
//      `safeFetch`/`safeFetchBuffer` 每跳只校验"不是内网 IP"，**没有域名白名单** ——
//      白名单图床 302 到任意公网主机照样会被下载。
//
// 这里全程**不联网**：性能用例喂纯字符串，白名单用例走 `checkUrlAllowed`（DNS 之前就拒绝）
// 与注入的 `fetchBuffer` 桩。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTiebaImageContent,
  extractImageUrls,
  htmlToText,
  isTiebaImageHost,
  parseBarPage,
  parseSo360Results,
  parseThreadPage,
  TIEBA_IMAGE_BYTES_MAX,
  TIEBA_IMAGE_MAX_URLS,
} from '../src/tieba-lib.js';
import { checkUrlAllowed, safeFetchBuffer } from '../src/safe-fetch.js';

const MB = 1024 * 1024;
/** 性能上界：1MB 畸形输入必须在这之内跑完（本机实测 3~61ms，留了余量）。 */
const PERF_BUDGET_MS = 100;

/**
 * 计时。先跑一次 4KB 的小输入做预热（正则/函数首次编译的 JIT 成本不该算进稳态上界；
 * 桥接是长驻进程，这里量的是稳态）。
 */
function timed(fn, warmupInput, input) {
  fn(warmupInput);
  const t0 = performance.now();
  const result = fn(input);
  const ms = performance.now() - t0;
  return { ms, result };
}

// ── ① 畸形输入的性能上界 ────────────────────────────────────────────────────
test('htmlToText：未闭合的 <script>/<style> 与海量 < 都是线性', () => {
  const cases = [
    ['无闭合 script', '<script'.repeat(Math.ceil(MB / 7)), '<script'.repeat(600)],
    ['无闭合 style', '<style'.repeat(Math.ceil(MB / 6)), '<style'.repeat(600)],
    ['海量 <', '<'.repeat(MB), '<'.repeat(600)],
  ];
  for (const [name, input, warm] of cases) {
    const { ms } = timed(htmlToText, warm, input);
    assert.ok(ms < PERF_BUDGET_MS, `${name}：${ms.toFixed(1)}ms 超过 ${PERF_BUDGET_MS}ms`);
  }
});

test('parseBarPage：<li 之后没有 > 时不再逐位回退', () => {
  const input = `<title>原神吧_百度贴吧</title>${'<li a'.repeat(Math.ceil(MB / 5))}`;
  const { ms, result } = timed(parseBarPage, '<title>x</title><li a', input);
  assert.ok(ms < PERF_BUDGET_MS, `parseBarPage：${ms.toFixed(1)}ms 超过预算`);
  assert.deepEqual(result.threads, [], '畸形输入认不出线程容器，但不该抛');
});

test('parseBarPage：海量 tl_shadow 标记（没有 <li）也不退化', () => {
  const input = `<title>x</title>${'tl_shadow'.repeat(Math.ceil(MB / 9))}`;
  const { ms } = timed(parseBarPage, '<title>x</title>tl_shadow', input);
  assert.ok(ms < PERF_BUDGET_MS, `parseBarPage(伪标记)：${ms.toFixed(1)}ms 超过预算`);
});

test('extractImageUrls：海量 content 容器 / 海量 <img 都不退化', () => {
  const cases = [
    ['content 容器', `<div class="content">x${'<div class="content">x'.repeat(Math.ceil(MB / 25))}`, '<div class="content">x'.repeat(80)],
    ['d_post_content', '<div class="d_post_content">'.repeat(Math.ceil(MB / 30)), '<div class="d_post_content">'.repeat(80)],
    ['img 无闭合', `<div class="content">${'<img'.repeat(Math.ceil(MB / 4))}`, '<div class="content"><img'],
  ];
  for (const [name, input, warm] of cases) {
    const { ms, result } = timed(extractImageUrls, warm, input);
    assert.ok(ms < PERF_BUDGET_MS, `${name}：${ms.toFixed(1)}ms 超过预算`);
    assert.deepEqual(result.urls, [], `${name} 不该凭畸形输入"认出"地址`);
  }
});

test('parseThreadPage：两种楼层形态的畸形输入都线性', () => {
  const cases = [
    ['海量 <li', '<li'.repeat(Math.ceil(MB / 3)), '<li'.repeat(60)],
    ['海量 d_post_content', '<div class="d_post_content">'.repeat(Math.ceil(MB / 30)), '<div class="d_post_content">'.repeat(60)],
    ['无闭合 content', '<div class="content">'.repeat(Math.ceil(MB / 21)), '<div class="content">'.repeat(60)],
  ];
  for (const [name, input, warm] of cases) {
    const { ms } = timed(parseThreadPage, warm, input);
    assert.ok(ms < PERF_BUDGET_MS, `${name}：${ms.toFixed(1)}ms 超过预算`);
  }
});

test('parseSo360Results：海量 <h3 / <a 都不退化', () => {
  const cases = [
    ['海量 <h3', `<li class="res-list">${'<h3'.repeat(Math.ceil(MB / 3))}`, '<li class="res-list"><h3'],
    ['海量 <a', `<li class="res-list">${'<a'.repeat(Math.ceil(MB / 2))}`, '<li class="res-list"><a'],
  ];
  for (const [name, input, warm] of cases) {
    const { ms } = timed(parseSo360Results, warm, input);
    assert.ok(ms < PERF_BUDGET_MS, `${name}：${ms.toFixed(1)}ms 超过预算`);
  }
});

test('畸形输入不影响正常解析（同一函数，语义没被改写）', () => {
  const barHtml = '<title>原神吧_百度贴吧</title>'
    + '<li class="tl_shadow" data-tid="111"><div class="ti_title"><span>标题A</span></div></li>'
    + '<li class="tl_top" data-tid="222"><div class="ti_title"><span>标题B</span></div></li>';
  assert.deepEqual(parseBarPage(barHtml).threads.map((t) => t.tid), ['111', '222']);

  const threadHtml = '<li tid="9001" data-tid="9001" fn="1" data-info="{}" class="list_item post_list_item">'
    + '<span class="user_name"><a class="user_name">甲</a></span>'
    + '<span class="list_item_time">2026-1-2</span>'
    + '<div class="content" lz="1">正文<img src="https://imgsa.baidu.com/forum/x.png"/></div></li>';
  const page = parseThreadPage(threadHtml);
  assert.equal(page.posts.length, 1);
  assert.equal(page.posts[0].content, '正文');

  const html = '<div>a</div><script>var x=1;</script><p>b</p>';
  assert.equal(htmlToText(html), 'a b');
});

// ── ② 图床域名白名单 ────────────────────────────────────────────────────────
test('isTiebaImageHost：只认百度图床后缀，不认"看起来像"的主机', () => {
  const yes = ['imgsa.baidu.com', 'tiebapic.baidu.com', 'pic.bdstatic.com', 'x.bdimg.com', 'bucket.bcebos.com', 'baidu.com', 'IMgSa.BaiDu.com', 'imgsa.baidu.com.'];
  const no = ['pic.zhimg.com', 'evil.baidu.com.evil.tld', 'evil-tld.com', 'baidu.com.evil', 'notbaidu.com', 'baidu.com.cn.evil', '', null, undefined];
  for (const host of yes) assert.equal(isTiebaImageHost(host), true, `应放行：${host}`);
  for (const host of no) assert.equal(isTiebaImageHost(host), false, `应拒绝：${host}`);
});

test('allowHost：首跳被拒时抛错并写明主机名，且不触发 DNS', async () => {
  const allow = isTiebaImageHost;
  assert.throws(() => checkUrlAllowed('https://evil.test/a.png', allow), /主机不在允许范围内，已阻止：evil\.test/);
  assert.throws(
    () => checkUrlAllowed('https://evil.baidu.com.evil.tld/a.png', allow),
    /主机不在允许范围内，已阻止：evil\.baidu\.com\.evil\.tld/
  );
  assert.throws(() => checkUrlAllowed('https://pic.zhimg.com/a.png', allow), /主机不在允许范围内/);
  // 放行时不抛，并回规范化 URL
  assert.equal(checkUrlAllowed('https://imgsa.baidu.com/a.png', allow), 'https://imgsa.baidu.com/a.png');

  // 真实调用：拒绝发生在 DNS 之前 —— 主机不存在也只会看到白名单错误，而不是 ENOTFOUND。
  await assert.rejects(
    () => safeFetchBuffer('https://no-such-host.invalid/a.png', 1024, { allowHost: allow }),
    /主机不在允许范围内，已阻止：no-such-host\.invalid/
  );
});

test('allowHost：重定向跳用同一个判定（每跳都会重新校验）', () => {
  const allow = isTiebaImageHost;
  // safeFetch/safeFetchBuffer 在每一跳都执行 `new URL(location, current)` → 解析 → 白名单。
  // 这里直接复现那个组合，证明"图床 302 到外站"会被拦在下载之前。
  const hop = (current, location) => checkUrlAllowed(new URL(location, current).toString(), allow);
  assert.throws(() => hop('https://imgsa.baidu.com/a.png', 'https://evil.test/b.png'), /已阻止：evil\.test/);
  assert.throws(() => hop('https://imgsa.baidu.com/a.png', '//cdn.evil-tld.com/b.png'), /已阻止：cdn\.evil-tld\.com/);
  assert.equal(hop('https://imgsa.baidu.com/a.png', 'https://tiebapic.baidu.com/b.png'), 'https://tiebapic.baidu.com/b.png');
});

test('allowHost：缺省不启用（既有调用方行为不变），非函数直接报错', () => {
  assert.equal(checkUrlAllowed('https://anything.test/x'), 'https://anything.test/x');
  assert.equal(checkUrlAllowed('https://anything.test/x', null), 'https://anything.test/x');
  assert.throws(() => checkUrlAllowed('https://anything.test/x', 'nope'), /allowHost 必须是函数/);
});

test('buildTiebaImageContent：非图床地址在入口就被丢掉，不发请求', async () => {
  const calls = [];
  const fetchBuffer = async (url) => { calls.push(url); return { buffer: Buffer.from([1, 2, 3]), statusCode: 200 }; };
  const out = await buildTiebaImageContent(
    ['https://evil.test/a.png', 'https://pic.zhimg.com/b.png', 'https://imgsa.baidu.com/forum/c.png'],
    { fetchBuffer }
  );
  assert.deepEqual(calls, ['https://imgsa.baidu.com/forum/c.png'], '只有图床地址会被下载');
  assert.equal(out.notes.length, 1);
});

test('buildTiebaImageContent：抓取时带上逐跳白名单 allowHost', async () => {
  const seen = [];
  await buildTiebaImageContent(['https://imgsa.baidu.com/forum/a.png'], {
    fetchBuffer: async (url, maxBytes, opts) => { seen.push(opts); return { buffer: Buffer.from([9]), statusCode: 200 }; },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].allowHost, isTiebaImageHost, 'allowHost 必须是图床判定函数本身');
});

test('buildTiebaImageContent：maxImages 夹到 1..上限（-1 不再是 slice(0,-1)）', async () => {
  const urls = Array.from({ length: 12 }, (_, i) => `https://imgsa.baidu.com/forum/p${i}.png`);
  const calls = [];
  const fetchBuffer = async (url) => { calls.push(url); return { buffer: Buffer.from([calls.length]), statusCode: 200 }; };

  await buildTiebaImageContent(urls, { maxImages: -1, fetchBuffer });
  assert.equal(calls.length, 1, '-1 应夹到 1（原来 slice(0,-1) 会取 11 张）');

  // 上限要喂够多的 URL 才看得出来：夹到 TIEBA_IMAGE_MAX_URLS（40），而不是"全取"
  const manyUrls = Array.from({ length: 50 }, (_, i) => `https://imgsa.baidu.com/forum/q${i}.png`);
  calls.length = 0;
  await buildTiebaImageContent(manyUrls, { maxImages: 999, fetchBuffer });
  assert.equal(calls.length, TIEBA_IMAGE_MAX_URLS, `999 应夹到 ${TIEBA_IMAGE_MAX_URLS}`);
  calls.length = 0;
  await buildTiebaImageContent(manyUrls, { maxImages: Infinity, fetchBuffer });
  assert.equal(calls.length, TIEBA_IMAGE_MAX_URLS, 'Infinity 应夹到上限而不是全取');

  calls.length = 0;
  await buildTiebaImageContent(urls, { maxImages: 3, fetchBuffer });
  assert.equal(calls.length, 3, '合法值原样生效');

  calls.length = 0;
  await buildTiebaImageContent(urls, { maxImages: 0, fetchBuffer });
  assert.equal(calls.length, 1, '0 应夹到 1');
});

test('buildTiebaImageContent：maxBytes 夹到 1..单张上限', async () => {
  const url = 'https://imgsa.baidu.com/forum/a.png';
  const bytes = [];
  const fetchBuffer = async (_url, maxBytes) => { bytes.push(maxBytes); return { buffer: Buffer.from([1]), statusCode: 200 }; };

  await buildTiebaImageContent([url], { maxBytes: 0, fetchBuffer });
  assert.equal(bytes.at(-1), 1, '0 应夹到 1');

  await buildTiebaImageContent([url], { maxBytes: 1e9, fetchBuffer });
  assert.equal(bytes.at(-1), TIEBA_IMAGE_BYTES_MAX, '超大值应夹到单张上限');

  await buildTiebaImageContent([url], { maxBytes: 2 * MB, fetchBuffer });
  assert.equal(bytes.at(-1), 2 * MB, '合法值原样生效');
});
