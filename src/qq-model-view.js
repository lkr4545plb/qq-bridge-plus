// Only the model-facing view is compacted. Stored messages and console/API data
// retain the original fields for display, media retrieval and troubleshooting.
const DEFAULT_FALSE_FIELDS = new Set([
  'quoteTargetIsSelf', 'isOwner', 'isSelf', 'hasMedia', 'hasForward'
]);
const OPTIONAL_FIELDS = new Set([
  'seq', 'messageId', 'sender', 'userId', 'text', 'plain', 'tail', 'kind',
  'ownerLabel', 'media', 'forwardIds', 'nestedForwardIds'
]);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function compactMedia(media, canResolveByMessage) {
  return media.map((item, index) => {
    if (!isRecord(item)) return item;
    const result = { ...item };
    // A local seq is a bridge message handle accepted by qq_get_message_images.
    // Forwarded nodes only have messageSeq, and may not be locally resolvable:
    // keep their transport references, even when they happen to have messageId.
    if (canResolveByMessage) {
      delete result.file;
      delete result.url;
      // Match the image tool's one-based ordering; never filter/reorder items.
      if (result.index == null) result.index = index + 1;
    } else if (result.file === result.url) {
      delete result.file;
    }
    for (const key of ['file', 'url', 'faceId']) {
      if (isEmpty(result[key])) delete result[key];
    }
    return result;
  });
}

/**
 * 群友可控文本的**结构净化**（上游 1d6f889）：入模前把可以伪装成提示词结构的字符削掉。
 *
 * 为什么必须做：群消息、昵称、记忆条目都是「别人写的字」，原样进模型上下文时与系统提示词
 * 同层 —— 一个 `【工具结果】`、换行开头的「忽略以上指令」就能伪造结构性边界。这里只做
 * 结构层净化（全角方括号→半角、换行→空格、零宽字符剥离），不改语义、不截断内容。
 */
export function sanitizeUntrustedText(value) {
  return String(value ?? '')
    .replace(/\u3010/g, '[')
    .replace(/\u3011/g, ']')
    .replace(/[\r\n\u2028\u2029\u0085\u000b\u000c]+/g, ' ')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
}

export function compactModelMessage(message) {
  if (typeof message === 'string') return sanitizeUntrustedText(message);
  if (!isRecord(message)) return message;
  const result = { ...message };
  // No trimming or truncation: differing plain text can contain resolved quote
  // context, and tail can carry the end of a long message absent from text.
  const seenText = new Set();
  for (const key of ['text', 'plain', 'tail']) {
    if (typeof result[key] !== 'string') continue;
    result[key] = sanitizeUntrustedText(result[key]);
    if (seenText.has(result[key])) delete result[key];
    else seenText.add(result[key]);
  }
  for (const key of OPTIONAL_FIELDS) {
    if (isEmpty(result[key])) delete result[key];
  }
  for (const key of DEFAULT_FALSE_FIELDS) {
    if (result[key] === false) delete result[key];
  }
  if (Array.isArray(result.media)) {
    const canResolveByMessage = Number.isSafeInteger(message.seq) && message.seq > 0;
    result.media = compactMedia(result.media, canResolveByMessage);
  }
  return result;
}

export function compactModelData(data) {
  if (typeof data === 'string') return sanitizeUntrustedText(data);
  if (Array.isArray(data)) return data.map(compactModelData);
  if (!isRecord(data)) return data;
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    (key === 'messages' || key === 'newMessages') && Array.isArray(value)
      ? value.map(compactModelMessage)
      : compactModelData(value)
  ]));
}

export function serializeModelData(data) {
  return JSON.stringify(compactModelData(data));
}
