// 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。
// 设计目标与 mcp-web-search-safe 一致：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
// - 域名先 DNS 解析并检查全部解析结果，避免 DNS rebinding
// - 手动跟随重定向，每一跳重新校验
// - 响应体限量读取，每次请求有包含响应体的总时限
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

const dnsLookup = dns.promises.lookup;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  let h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(h);
  // DNS 返回值也必须是有效 IP；不能把非法地址当成公网地址。
  if (!family || h.includes('%')) return true;
  if (family === 6) h = new URL(`http://[${h}]/`).hostname.slice(1, -1);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // Azure WireServer：字面上是公网 IPv4，但在 Azure VM 内指向平台服务（SSRF 可达）。
    if (h === '168.63.129.16') return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    // 本地 NAT64 前缀的 IPv4 位布局不等同 /96；整个本地前缀均不可供公网抓取。
    if (h.startsWith('64:ff9b:1:')) return true;
    const embedded = parseEmbeddedIpv4(h);
    if (embedded) return isPrivateIp(embedded);
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }

  return true;
}

function orderAddresses(addresses) {
  const v4 = addresses.filter((item) => Number(item?.family) === 4).map((item) => item.address);
  const v6 = addresses.filter((item) => Number(item?.family) === 6).map((item) => item.address);
  const ordered = [];
  const max = Math.max(v4.length, v6.length);
  for (let i = 0; i < max; i += 1) {
    if (v4[i]) ordered.push(v4[i]);
    if (v6[i]) ordered.push(v6[i]);
  }
  return ordered;
}

/** 解析主机名并校验**全部**解析结果，返回可尝试的地址列表（IPv4 优先）。 */
export async function resolveSafeAddresses(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return [h];
  }
  let addresses;
  try {
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), 5000, `DNS 解析 ${h}`);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      if (/^198\.(?:18|19)\./.test(address)) {
        throw new Error('域名解析到 198.18.0.0/15 保留地址，已阻止；这可能是 Clash/mihomo 的 fake-ip。'
          + '请使用返回真实公网 IP 的 DNS（如 redir-host），或按代理的 fake-ip-filter 规则让该域名返回真实地址。'
          + '私有/保留地址不会被放行');
      }
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  const ordered = orderAddresses(addresses);
  return ordered.length ? ordered : [addresses[0].address];
}

export async function resolveSafeHost(hostname) {
  const [first] = await resolveSafeAddresses(hostname);
  return first;
}

/**
 * 只做「URL 语法 + 协议 + 凭据」校验，**不解析 DNS**。
 *
 * 拆出来是为了让域名白名单能先于 DNS 生效：被白名单拒掉的主机不该再触发一次解析
 * （既省一次网络往返，也不把被拒主机名送进解析器），同时让白名单逻辑可以离线测。
 */
export function parseFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  return url;
}

export async function validateFetchUrl(raw, opts = {}) {
  const url = parseFetchUrl(raw);
  // 可选端口白名单：默认不限（保持既有调用方行为），走公网抓取的入口显式传入。
  //
  // 为什么需要：SSRF 防护只判定"地址是不是内网"，不判定"端口是不是该服务的端口"。
  // 一个**公网可达**的非常规端口（比如某内网服务通过端口映射暴露在 8081/9200）在
  // 地址判定看来是合法的，于是能被拿来探测。端口白名单把"能抓什么"收窄到
  // 常规 Web 端口，与地址判定互补。
  if (Array.isArray(opts.allowPorts) && opts.allowPorts.length) {
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    if (!Number.isInteger(port) || !opts.allowPorts.includes(port)) {
      throw new Error(`端口 ${port} 不在允许列表（${opts.allowPorts.join('/')}）内，已阻止`);
    }
  }
  const addresses = await resolveSafeAddresses(url.hostname);
  return { url, ip: addresses[0], addresses };
}

/**
 * 只校验「这个 URL 是否被 allowHost 放行」，不解析 DNS、不发请求。
 *
 * 导出它是为了让调用方/测试能单独验证白名单判定（首跳与重定向跳走的是同一个 `assertAllowedHost`）。
 * 返回规范化后的 URL 字符串，被拒时抛错（错误里带主机名）。
 */
export function checkUrlAllowed(raw, allowHost) {
  const url = parseFetchUrl(raw);
  assertAllowedHost(url, allowHost);
  return url.toString();
}

/**
 * 逐跳域名白名单（默认关闭）。
 *
 * 为什么需要：`validateFetchUrl` 只保证「不是内网/本机」，**不限制它是谁**。贴吧图床的 URL 一旦
 * 被 302 到任意公网主机，字节照样会被下载下来（`buildTiebaImageContent` 之前只在入口过滤
 * `^https?://`，没有做域名白名单）。调用方传 `allowHost` 后，**每一跳**（含重定向后的目标）都要
 * 过一遍，被拒时抛错并写清主机名。
 *
 * `allowHost` 缺省为 null/undefined ⇒ 完全不启用，既有调用方的行为逐字节不变。
 */
function assertAllowedHost(url, allowHost) {
  if (allowHost === undefined || allowHost === null) return;
  if (typeof allowHost !== 'function') throw new Error('allowHost 必须是函数');
  let allowed = false;
  try {
    allowed = allowHost(url.hostname) === true;
  } catch (error) {
    throw new Error(`allowHost 校验异常（${url.hostname}）：${error?.message ?? error}`);
  }
  if (!allowed) throw new Error(`主机不在允许范围内，已阻止：${url.hostname}`);
}

/** 首跳/每一跳的统一入口：语法校验 → **域名白名单** → DNS 解析 → 内网拦截。 */
async function resolveTarget(raw, allowHost, allowPorts) {
  const url = parseFetchUrl(raw);
  assertAllowedHost(url, allowHost);
  // 可选端口白名单（见 validateFetchUrl 的说明）：SSRF 地址判定之外的端口收窄。
  if (Array.isArray(allowPorts) && allowPorts.length) {
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    if (!Number.isInteger(port) || !allowPorts.includes(port)) {
      throw new Error(`端口 ${port} 不在允许列表（${allowPorts.join('/')}）内，已阻止`);
    }
  }
  // 返回**全部**已校验地址（IPv4 优先，见 orderAddresses）：requestOnce 会逐个尝试，
  // 避免「第一个地址不可达就整个抓取失败」。
  const addresses = await resolveSafeAddresses(url.hostname);
  return { url, addresses };
}

const REQUEST_TIMEOUT_MS = 20000;
// 多地址时的单次尝试预算：够一次 TCP+TLS+首字节，又不至于让「第一个地址是坏的 IPv6」
// 把整个请求预算耗光 —— 这是表情包/图片抓取「时好时坏」的根因：域名同时解析出 IPv6 与
// IPv4 时，旧实现只看解析结果的第一个地址（可能不可达），没有换地址重试。
const ATTEMPT_TIMEOUT_MS = 8000;
// 最多换几个地址重试：DNS 返回几十个地址时不该逐个撞完整个 20s 预算。
const MAX_ADDRESS_ATTEMPTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function validateLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须为正整数`);
}

/**
 * 把调用方**追加**的请求头规范成可安全合并的普通对象（`safeFetch(url, maxChars, { headers })`）。
 *
 * 三条硬边界（都是为了让「追加头」不变成新的注入面）：
 *   · 不传（undefined/null）⇒ 返回 null：调用方走**逐字节不变**的默认头路径，行为与以前完全一致；
 *   · **不允许覆盖 `host`**（含任意大小写）：请求打到哪个 IP 由 URL 校验决定，Host/SNI 必须与 URL
 *     一致，否则「已校验 IP + 任意 Host」就是一台可被用来打任意虚拟主机的代理；直接抛错而不是静默丢弃，
 *     避免调用方以为设置生效了；
 *   · 名称必须是合法 HTTP token、值必须单行（拒 CR/LF，防请求头注入）。非法输入在**发请求之前**抛错。
 */
function normalizeHeaderOverrides(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('headers 必须是普通对象');
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    const key = String(name).trim().toLowerCase();
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(key)) throw new Error(`请求头名称非法：${name}`);
    if (key === 'host') throw new Error('headers 不能覆盖 host');
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (/[\r\n]/.test(text)) throw new Error(`请求头值不能包含换行：${name}`);
    out[key] = text;
  }
  return out;
}

// 使用已校验的 IP 发起请求，保留原始 Host/SNI，禁止重新解析 DNS。
// 总时限包含 TCP/TLS、响应头和响应体；仅 socket idle timeout 无法阻止慢速滴流。
// `extraHeaders` 为已规范化的追加头（见 normalizeHeaderOverrides）：null 表示一个字节都不加。
//
// 多地址重试（与上游 safe-fetch 对齐）：一次请求最多尝试 MAX_ADDRESS_ATTEMPTS 个地址。
//   · 单地址：沿用 20s 整预算（与以前逐字节一致）；
//   · 多地址：每个地址 8s 软预算，总量不超过总预算；网络层失败（连接拒绝/超时/EOF）
//     换地址重试，策略层失败（大小超限/协议错误）立即终止 —— 换地址也修不好。
function attemptOnce(url, address, limit, binary, budgetMs, extraHeaders) {
  return new Promise((resolve) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) resolve({ ok: false, error, retryable: true });
      else resolve({ ok: true, result });
    };
    const finishPolicy = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error, retryable: false });
    };
    const timer = setTimeout(() => {
      const error = new Error(`请求超时：${url.hostname}`);
      finish(error);
      req?.destroy(error);
      response?.destroy();
    }, budgetMs);

    const mod = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    try {
      // 默认头集合逐字节保持原样（键序也不变）；只有调用方显式传了 headers 时才在后面追加。
      const headers = {
        host: url.host,
        'user-agent': 'Mozilla/5.0',
        accept: binary ? 'image/*,*/*;q=0.8' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      };
      if (extraHeaders) Object.assign(headers, extraHeaders);
      req = mod.request({
        // 连接到已校验的 IP：Host/SNI 仍是原域名，地址判定不能被 DNS rebinding 绕过。
        // IPv6 字面量自带方括号，mod.request 的 host 参数接受不带括号的形式。
        hostname: address,
        servername: net.isIP(url.hostname) ? undefined : hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        timeout: budgetMs,
        rejectUnauthorized: true,
      }, (res) => {
        response = res;
        const statusCode = res.statusCode || 0;
        // 3xx：不下载重定向正文：攻击者可以发送无限正文消耗连接和带宽。
        if ([301, 302, 303, 307, 308].includes(statusCode)) {
          res.destroy();
          finish(null, { statusCode, redirect: res.headers.location || '' });
          return;
        }
        if (binary) {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > limit) {
              finishPolicy(new Error(`图片超过大小限制（${limit} 字节）`));
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (settled) return;
            finish(null, { statusCode, buffer: Buffer.concat(chunks) });
          });
        } else {
          const decoder = new StringDecoder('utf8');
          const chunks = [];
          let size = 0;
          const appendText = (text) => {
            const points = Array.from(text);
            const remaining = limit - size;
            // 截断用码点切，避免把 emoji 的代理对从中间劈开（与 md-to-plain 的约定一致）。
            if (points.length > remaining) {
              chunks.push(points.slice(0, Math.max(remaining, 0)).join(''));
              size = limit;
            } else {
              chunks.push(text);
              size += points.length;
            }
          };
          res.on('data', (chunk) => {
            if (settled) return;
            appendText(decoder.write(chunk));
          });
          res.on('end', () => {
            if (settled) return;
            appendText(decoder.end());
            finish(null, { statusCode, body: chunks.join(''), truncated: size >= limit });
          });
        }
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('连接中断')));
        res.on('close', () => {
          if (!res.complete) finish(new Error('连接中断'));
        });
      });
      req.on('timeout', () => {
        const error = new Error(`请求超时：${url.hostname}`);
        finish(error);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => finish(error));
      req.end();
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

async function requestOnce(url, addresses, limit, binary = false, extraHeaders = null) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  if (!list.length) throw new Error(`没有可用地址：${url.hostname}`);
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const attempts = Math.min(list.length, MAX_ADDRESS_ATTEMPTS);
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 250) break;
    const budget = list.length === 1 ? REQUEST_TIMEOUT_MS : Math.min(ATTEMPT_TIMEOUT_MS, remaining);
    const outcome = await attemptOnce(url, list[i], limit, binary, budget, extraHeaders);
    if (outcome.ok) return outcome.result;
    lastError = outcome.error;
    if (!outcome.retryable) throw outcome.error;
    if (i < attempts - 1) {
      // 换地址重试：只换连接目标，Host/SNI/路径全部不变（同一个站点）。
      await new Promise((r) => setTimeout(r, 50 + i * 100));
    }
  }
  throw lastError ?? new Error(`请求超时：${url.hostname}`);
}

/**
 * 读取一个 URL 并返回正文。
 *
 * `opts.allowHost`（可选，`(hostname) => boolean`）是**逐跳域名白名单**：不传时行为与以前完全一致；
 * 传了则首跳与每一次重定向都要通过，否则抛错并写明被拒主机（见 assertAllowedHost）。
 *
 * `opts.headers`（可选）是**追加/覆盖**请求头的最小口子：不传时请求头、超时、重定向与地址防护
 * 与以前**逐字节一致**；传了也仍然遵守原有防护——每一跳（含重定向后的最终目标）都重新
 * `validateFetchUrl`，`host` 由 URL 决定不接受覆盖，且跨源重定向会**丢掉**追加头（否则调用方给的
 * 凭据会被一次开放重定向送去第三方）。
 */
export async function safeFetch(urlString, maxChars = 50000, opts = {}) {
  validateLimit(maxChars, 'maxChars');
  const MAX_REDIRECTS = 5;
  let extraHeaders = normalizeHeaderOverrides(opts?.headers);
  let { url, addresses } = await resolveTarget(urlString, opts?.allowHost, opts?.allowPorts);
  const origin = url.origin;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, addresses, maxChars, false, extraHeaders);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, addresses } = await resolveTarget(next, opts?.allowHost, opts?.allowPorts));
      if (url.origin !== origin) extraHeaders = null;
      continue;
    }
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: result.truncated,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 仅接受 DSH 支持的四种图片格式：PNG/JPEG/GIF/WebP。 */
export function looksLikeImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

/**
 * 抓取图片字节并返回 Buffer（带 SSRF 防护，且校验确实为图片）。
 *
 * `opts.allowHost`（可选）与 `safeFetch` 相同：逐跳校验域名白名单，被拒时抛错并写明主机名。
 *
 * `opts.headers`（可选）与 `safeFetch` 走**同一套**规范化与边界（`normalizeHeaderOverrides`）：
 *   · 不传 ⇒ 请求头、超时、重定向、逐跳地址校验与以前**逐字节一致**（`binary` 形态的默认头集合
 *     也一个键都没动）；
 *   · 传了 ⇒ 只**追加/覆盖**这些头，`host` 仍由 URL 决定（覆盖 `host` 直接抛错，不静默丢弃）；
 *   · 头名必须是合法 token、值必须单行（拒 CR/LF）；非法输入在发请求之前抛错；
 *   · 跨源重定向丢掉追加头（否则贴吧图床的 referer/cookie 会被一次开放重定向送去第三方）。
 *
 * 为什么需要它（t78）：贴吧图床对 `referer` 有要求（不带 referer 会 403），而「带上来源页」这件事
 * 只能由调用方追加。
 */
export async function safeFetchBuffer(urlString, maxBytes = 4 * 1024 * 1024, opts = {}) {
  validateLimit(maxBytes, 'maxBytes');
  const MAX_REDIRECTS = 5;
  let extraHeaders = normalizeHeaderOverrides(opts?.headers);
  let { url, addresses } = await resolveTarget(urlString, opts?.allowHost, opts?.allowPorts);
  const origin = url.origin;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, addresses, maxBytes, true, extraHeaders);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, addresses } = await resolveTarget(next, opts?.allowHost, opts?.allowPorts));
      if (url.origin !== origin) extraHeaders = null;
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`图片抓取失败：HTTP ${result.statusCode}`);
    }
    if (!looksLikeImageBuffer(result.buffer)) {
      throw new Error(`抓取内容不是有效图片（PNG/JPEG/GIF/WebP）`);
    }
    return { url: url.toString(), statusCode: result.statusCode, buffer: result.buffer };
  }
  throw new Error('重定向次数过多，已停止');
}
