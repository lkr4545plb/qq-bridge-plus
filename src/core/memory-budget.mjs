/**
 * 记忆注入的字符预算：把「渲染哪些记忆」变成一条可配置、可测试的纯策略。
 *
 * 为什么需要这一层
 * ----------------
 * 记忆是**每轮唤醒都要重发**的文本，而它的成本此前只有「条数上限」（话题 10 条 /
 * 印象 5 人），没有「字符上限」：每条话题最多 200 字、每个人的 traits 最多 10×50 字，
 * 于是最坏情况单次注入可以到十几 KB，且这个上限不受 `socialV2.context.wakeMaxChars`
 * 约束——那个预算只管 messages/recent 那个 packet（`buildWakeSnapshotV2`），
 * 管不到记忆块。也就是说：记忆是唯一一个「有上限，但上限失效」的注入面。
 *
 * 这里把裁剪算法抽成纯函数，好处有三：
 *   · 可以离线断言「输出永不超过预算」这条性质（`scripts/test-memory-budget.mjs`）；
 *   · 裁剪顺序与优先级集中在一处，不再散在渲染代码的临时判断里；
 *   · 桥接只负责把记忆拼成「带 kind 的行」，不负责算术。
 *
 * 语义约定（调用方必须遵守）
 * --------------------------
 *   · 预算只**裁剪展示**，不回写状态：被裁掉的记忆仍然在 `state/social-v2.json` 里，
 *     下次预算宽松、或模型主动 `qq_memory_query` 时还能看到。
 *   · 裁掉了就**必须留痕**：输出末尾追加一句说明（省了什么、去哪看），否则模型会以为
 *     记忆是空的，进而重新去记同样的东西——那等于把省下的 token 又花回去。
 *   · 空段落（没有任何行）不进输出，连标题也不出现，避免「标题在、内容是空」的噪声。
 */

/** 单次记忆注入的字符预算：默认值 / 上下界。 */
export const MEMORY_INJECT_MAX_CHARS_DEFAULT = 1800;
export const MEMORY_INJECT_MAX_CHARS_MIN = 400;
export const MEMORY_INJECT_MAX_CHARS_MAX = 8000;

/** 每个人的 traits 最多渲染几条：存储仍保留 10 条，只是不全都塞进提示。 */
export const MEMORY_TRAITS_RENDER_MAX_DEFAULT = 4;
export const MEMORY_TRAITS_RENDER_MAX_MAX = 10;

/** 裁剪说明预留的字符数：估算时按固定值留位，实际文案不超这个量级。 */
export const MEMORY_NOTE_RESERVE = 200;

const clampInt = (value, min, max, fallback) => {
  // `null` / 布尔 / 空串必须先挡掉：`Number(null) === 0`、`Number(true) === 1`，
  // 直接 Number() 会把「没配」变成「配成最小值」，静默把预算压到下限。
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/**
 * 归一化 `socialV2.memory` 里与注入相关的两个字段。
 *
 * 只认数字：`"1500"` 会被 `Number()` 转成 1500（配置是手写的，容忍字符串数字），
 * 但 `null` / `true` / `"abc"` 一律回默认——**不是 fail-open**：预算字段拿不到合法值就
 * 用默认预算，绝不会变成 `Infinity`（那等于取消预算）。
 */
export function normalizeMemoryInjectConfig(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    maxInjectChars: clampInt(
      src.maxInjectChars,
      MEMORY_INJECT_MAX_CHARS_MIN,
      MEMORY_INJECT_MAX_CHARS_MAX,
      MEMORY_INJECT_MAX_CHARS_DEFAULT
    ),
    traitsRenderMax: clampInt(
      src.traitsRenderMax,
      0,
      MEMORY_TRAITS_RENDER_MAX_MAX,
      MEMORY_TRAITS_RENDER_MAX_DEFAULT
    ),
  };
}

/**
 * 截断 traits 列表：返回要展示的部分与「还有几条没展示」。
 *
 * `max = 0` 表示一条都不展示（只剩人数与互动次数），用于把印象压到最省。
 */
export function clipTraits(traits, max) {
  const list = Array.isArray(traits) ? traits.filter((t) => typeof t === 'string' && t.length > 0) : [];
  const limit = clampInt(max, 0, MEMORY_TRAITS_RENDER_MAX_MAX, MEMORY_TRAITS_RENDER_MAX_DEFAULT);
  if (list.length <= limit) return { shown: list, hidden: 0 };
  return { shown: list.slice(0, limit), hidden: list.length - limit };
}

/**
 * 把「段落 + 行」按预算裁成最终文本。
 *
 * @param {Array<{id:string, header?:string, tail?:string, priority:number,
 *                dropFrom?:'start'|'end',
 *                lines:Array<{text:string, kind:'topic'|'impression'|'thought'}>}>} sections
 *        `priority` **越小越先被裁**（低价值段落先掉）。`dropFrom` 决定同一段内先丢哪一头：
 *        `'end'`（默认）丢最新/最近在末尾的那些，`'start'` 丢最旧的。
 * @param {{maxChars:number, noteFor?:Function}} options
 *        `noteFor(dropped, sectionsLeft)` 返回「被裁了」的说明文案；省略则不追加说明。
 * @returns {{text:string, dropped:{topic:number,impression:number,thought:number},
 *            budget:number, chars:number, truncated:boolean}}
 */
export function planMemoryInject(sections, options = {}) {
  const budget = clampInt(
    options?.maxChars,
    MEMORY_INJECT_MAX_CHARS_MIN,
    MEMORY_INJECT_MAX_CHARS_MAX,
    MEMORY_INJECT_MAX_CHARS_DEFAULT
  );
  const noteFor = typeof options?.noteFor === 'function' ? options.noteFor : null;

  // 结构化拷贝：只保留有内容的段落，避免调用方的数组被就地修改。
  const plan = (Array.isArray(sections) ? sections : [])
    .filter((s) => s && Array.isArray(s.lines) && s.lines.length > 0)
    .map((s, index) => ({
      id: String(s.id ?? `section-${index}`),
      header: typeof s.header === 'string' ? s.header : '',
      tail: typeof s.tail === 'string' ? s.tail : '',
      priority: Number.isFinite(Number(s.priority)) ? Number(s.priority) : 99,
      dropFrom: s.dropFrom === 'start' ? 'start' : 'end',
      lines: s.lines
        .filter((l) => l && typeof l.text === 'string' && l.text.length > 0)
        .map((l) => ({ text: l.text, kind: l.kind === 'impression' || l.kind === 'thought' ? l.kind : 'topic' })),
      dropped: 0,
    }))
    .filter((s) => s.lines.length > 0);

  const dropped = { topic: 0, impression: 0, thought: 0 };

  const renderSection = (section) => {
    if (section.lines.length === 0) return '';
    const body = section.lines.map((l) => l.text).join('\n');
    const head = section.header ? `${section.header}\n` : '';
    const tail = section.tail ? `\n${section.tail}` : '';
    return `${head}${body}${tail}`;
  };
  const renderAll = () => plan.map(renderSection).filter(Boolean);

  const noteText = () => {
    if (!noteFor) return '';
    const total = dropped.topic + dropped.impression + dropped.thought;
    if (total === 0) return '';
    return noteFor({ ...dropped }, plan.filter((s) => s.lines.length > 0).map((s) => s.id));
  };
  // 拼接后的长度：各段之和 + 段间换行符（n 段之间有 n-1 个 '\n'）。
  const lengthOf = (parts) => parts.reduce((sum, part) => sum + part.length, 0) + Math.max(0, parts.length - 1);

  // 单次裁剪：从**最低优先级**的非空段落里取一行丢掉。
  // 同一优先级内按段落声明顺序（先声明的先掉），保证顺序是确定的、可断言的。
  const dropOne = () => {
    let target = null;
    for (const section of plan) {
      if (section.lines.length === 0) continue;
      if (!target || section.priority < target.priority) target = section;
    }
    if (!target) return false;
    const line = target.dropFrom === 'start' ? target.lines.shift() : target.lines.pop();
    target.dropped += 1;
    dropped[line.kind] += 1;
    return true;
  };

  // 预算里先扣掉说明文案的位置：只在真要裁剪时扣，未超预算的输出一个字都不动。
  const fits = () => {
    const parts = renderAll();
    const note = noteText();
    const total = lengthOf(parts) + (note ? (parts.length > 0 ? 1 : 0) + note.length : 0);
    return { ok: total <= budget, total };
  };

  let state = fits();
  // 说明文案本身会随裁剪变长（三种计数都从 0 变正），所以每丢一行都重新量一次；
  // 行数是 ≤ 预算/最短行的量级，最坏也就几百次比较，且只在超预算时发生。
  let guard = 0;
  while (!state.ok && guard <= 10000) {
    if (!dropOne()) break;
    guard += 1;
    state = fits();
  }

  const parts = renderAll();
  const note = noteText();
  const text = [parts.join('\n'), note].filter(Boolean).join('\n');

  return {
    text,
    dropped: { ...dropped },
    budget,
    chars: text.length,
    truncated: dropped.topic + dropped.impression + dropped.thought > 0,
  };
}
