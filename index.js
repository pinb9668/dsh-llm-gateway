/**
 * @local/dsh-llm-gateway — local OpenAI-compatible gateway over DSH's `llm` service.
 *
 * All model calls go through `ctx.llm.stream({ provider, model, ... })`; this
 * plugin never contacts an upstream itself. Configuration is read entirely from
 * the `config` argument of `apply()` (no exported Config object — a plain object
 * triggers "Cannot read properties of undefined (reading 'validate')" and a
 * scoped schemastery may not resolve for a local directory install).
 */

import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const name = 'dsh-llm-gateway';
// `attachments` 用于把工具返回的内联图片落成真实附件，让模型能看到图；
// 没有该服务时退化为占位文本（见 imagePlaceholder）。
export const inject = ['llm', 'attachments'];

const DEFAULTS = { host: '127.0.0.1', port: 8392, apiKey: '' };
const CACHE_MS = 10_000;
const GROUP_PREFIXES = new Set(['deepseek', 'buddy', 'free']);

/**
 * 推理档位的「槽位」方案。
 *
 * 背景：Codex 桌面端有两道限制，都不是网关能控制的——
 *   1. `ReasoningEffort` 是固定枚举，不认识的档位名在解析目录时**静默丢弃**
 *      （`parseCatalog` 里逐个 `safeParse`，失败即跳过）；
 *   2. 模型选择器的可见档位再过一道白名单 `enabled-reasoning-efforts`，
 *      默认值是 ["low","medium","high","xhigh","ultra","persistent"]，
 *      `none` / `max` / `minimal` 都不在里面。
 *
 * 于是「上游有 4 档」的模型在界面上只剩 `low`/`high` 两档——不是因为目录错了，
 * 而是 `none`/`max` 被这两道闸门吃掉了。
 *
 * 解决办法：网关不再把上游的原始档位名发给客户端，而是发**固定的槽位序列**。
 * 模型有几档就发几个槽位，第 N 个槽位始终是同一个名字：
 *
 *     槽位: low → medium → high → xhigh → ultra
 *
 * 客户端选第 k 个槽位，网关在转发上游时再换回该模型自己的第 k 个档位。
 * 槽位名只是为了「让 Codex 认得并画出来」，语义上就是 1、2、3……
 *
 * 为什么选这五个名字：它们在 Codex 枚举里、在桌面端白名单里、且不会被
 * 那条 `"persistent" !== effort` 的过滤链摘掉。
 */
const SLOT_LADDER = ['low', 'medium', 'high', 'xhigh', 'ultra'];

/**
 * 把一个模型的真实档位列表压成槽位。
 *
 * - 档位数 ≤ 槽位数：一一对应，槽位就是前 N 个名字；
 * - 档位数 > 槽位数（实测最多 7 档，只有 2 个免费通道模型）：按等距抽样取代表，
 *   保证最强档和档位两端一定被覆盖。返回的 `map` 让换算可逆。
 *
 * @param {string[]} levels 上游声明的档位，按弱到强。
 * @returns {{ slots: string[], map: Map<string,string> }}
 */
function slotize(levels) {
  const n = Array.isArray(levels) ? levels.length : 0;
  if (n === 0) return { slots: [], map: new Map() };
  const slots = SLOT_LADDER.slice(0, Math.min(n, SLOT_LADDER.length));
  const map = new Map();
  if (n <= SLOT_LADDER.length) {
    // 一一对应
    for (let i = 0; i < n; i += 1) map.set(SLOT_LADDER[i], levels[i]);
  } else {
    // 等距抽样：0 .. n-1 均匀落到 slots.length 个点上
    const last = slots.length - 1;
    for (let i = 0; i < slots.length; i += 1) {
      const idx = Math.round((i * (n - 1)) / last);
      map.set(slots[i], levels[idx]);
    }
  }
  return { slots, map };
}

/** 客户端发来的槽位名 → 上游真档位名。认不出就返回 undefined（不传档位）。 */
function resolveSlot(entry, requested) {
  if (typeof requested !== 'string' || requested === '') return undefined;
  if (entry?.slotMap instanceof Map) {
    const hit = entry.slotMap.get(requested);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const DEEPSEEK_PROVIDERS = new Set([
  'deepseek-official',
  'deepseek-account',
  'deepseek-flash',
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-free',
]);
const BUDDY_PROVIDERS = new Set(['workbuddy', 'workbuddy-global']);

function groupOf(provider) {
  if (DEEPSEEK_PROVIDERS.has(provider)) return 'deepseek';
  if (BUDDY_PROVIDERS.has(provider)) return 'buddy';
  return 'free';
}

function publicIdOf(entry) {
  const group = entry.group;
  const model = entry.model;
  // Keep ids that already contain '/' intact after the prefix, so
  // opencode/beam-free and reflection/beam-free never collide.
  return `${group}/${model}`;
}

function normalizeConfig(raw) {
  const config = { ...DEFAULTS };
  if (raw !== null && typeof raw === 'object') {
    if (typeof raw.host === 'string' && raw.host !== '') config.host = raw.host;
    if (Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536) config.port = raw.port;
    if (typeof raw.apiKey === 'string') config.apiKey = raw.apiKey;
  }
  return config;
}

function textBlock(text) {
  return { type: 'text', text };
}

function contentToBlocks(content) {
  if (typeof content === 'string') return content === '' ? [] : [textBlock(content)];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue;
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      if (typeof part.text === 'string' && part.text !== '') blocks.push(textBlock(part.text));
    }
  }
  return blocks;
}

/**
 * 工具结果里的图片被挪进合成 user 消息时带的占位正文。
 *
 * 与参考实现（misakano7545/workbuddy2api-panel 的 toolImagePlaceholder）同口径：
 * Chat 的 tool 消息不能带图，图片必须另起一条 user 消息送上去，
 * 而那条消息需要一句正文说明这些图是从哪来的。
 */
const TOOL_IMAGE_PLACEHOLDER = '[image from tool result]';

/** 一张内联图片（data URL / http URL）在文本里应该占多少字节才算「占位」。 */
function isInlineImageUrl(value) {
  return typeof value === 'string' && /^data:image\//iu.test(value);
}

/** 解析 data URL → { mediaType, bytes }。解析失败返回 undefined。 */
function parseDataUrl(url) {
  if (typeof url !== 'string') return undefined;
  const m = /^data:([^;,]+)(?:;base64)?,(.*)$/isu.exec(url);
  if (m === null) return undefined;
  const mediaType = m[1].toLowerCase();
  if (!/^image\/(png|jpeg|webp|gif)$/u.test(mediaType)) return undefined;
  try {
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length === 0) return undefined;
    return { mediaType, bytes };
  } catch {
    return undefined;
  }
}

/** 图片占位文本：保留可读线索，丢掉 base64。 */
function imagePlaceholder(imageUrl, label = '图片') {
  if (isInlineImageUrl(imageUrl)) {
    const mime = /^data:([^;,]+)/iu.exec(imageUrl)?.[1] ?? 'image';
    return `[${label}：${mime}，已省略原始数据]`;
  }
  if (typeof imageUrl === 'string' && imageUrl !== '') return `[${label}：${imageUrl}]`;
  return `[${label}]`;
}

/**
 * 从任意值里安全地取出文本。
 *
 * ⚠️ 这里曾有一个会撑爆上游的缺陷：`function_call_output.output` 在「工具返回
 * 图片」时是一个数组，旧代码走 `JSON.stringify(item.output)`，把整段 base64
 * 当普通正文塞进了 content。一张 2.47MB 的截图 base64 约 86 万 token，而它
 * 作为真正的图片只有 1~2k token —— 膨胀近 600 倍，于是上游直接以 11115
 * 「prompt is too long」拒绝整轮。DSH 直连时同一个会话没问题，正是因为图片
 * 走的是多模态 content block，不是文本。
 *
 * 现在：识别到内联图片就换成占位文本，并把其中的图片数据彻底丢弃。
 */
function contentToText(content, label = '图片') {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue;
    if (typeof part.text === 'string') {
      parts.push(part.text);
      continue;
    }
    // OpenAI Responses 的图片 part：{type:'input_image', image_url}
    // Chat Completions 的图片 part：{type:'image_url', image_url:{url}}
    if (part.type === 'input_image' || part.type === 'image_url' || part.image_url !== undefined) {
      const raw = typeof part.image_url === 'object' && part.image_url !== null
        ? part.image_url.url
        : part.image_url;
      parts.push(imagePlaceholder(raw, label));
    }
  }
  return parts.join('\n');
}

function finishReasonOf(reason) {
  if (reason === undefined || reason === null) return 'stop';
  switch (reason.kind) {
    case 'stop':
      return 'stop';
    case 'tool-calls':
      return 'tool_calls';
    case 'max-tokens':
      return 'length';
    default:
      return 'stop';
  }
}

function failureOf(reason) {
  if (reason === undefined || reason === null) return undefined;
  if (reason.kind !== 'error' && reason.kind !== 'aborted') return undefined;
  return reason.failure ?? { message: 'upstream failed', code: 'UPSTREAM_ERROR' };
}

function uuid() {
  return randomUUID();
}

/* ------------------------------------------------------------------ *
 * Request conversion: both Wire protocols -> DSH GenerateOptions.messages
 * ------------------------------------------------------------------ */

/**
 * Chat Completions messages -> DSH messages.
 * Assistant tool_calls become tool-call blocks in the same message; role:tool
 * messages become DSH tool messages carrying the same call id.
 */
export function chatMessagesToDsh(rawMessages, options = {}) {
  const messages = [];
  for (const raw of Array.isArray(rawMessages) ? rawMessages : []) {
    if (raw === null || typeof raw !== 'object') continue;
    switch (raw.role) {
      case 'system':
      case 'developer':
        // developer 和 system 都作为 system 提示词，不能丢。
        messages.push({
          id: uuid(),
          role: 'system',
          content: contentToBlocks(raw.content),
          source: { kind: 'system-prompt' },
        });
        break;
      case 'assistant': {
        const blocks = contentToBlocks(raw.content);
        for (const call of Array.isArray(raw.tool_calls) ? raw.tool_calls : []) {
          const fn = call?.function;
          if (fn === undefined || fn === null) continue;
          const id = typeof call.id === 'string' && call.id !== '' ? call.id : uuid();
          blocks.push({
            type: 'tool-call',
            id,
            name: typeof fn.name === 'string' ? fn.name : '',
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          });
        }
        messages.push({
          id: uuid(),
          role: 'assistant',
          content: blocks,
          source: { kind: 'model', provider: options.provider ?? 'gateway', model: options.model ?? 'gateway' },
        });
        break;
      }
      case 'tool': {
        const callId = raw.tool_call_id ?? raw.call_id ?? uuid();
        // 结构化 content（含图片 part）要原样带下去，供 materializeImages 提取；
        // 只有确实是纯字符串/纯文本数组时才走文本化。
        const structured = Array.isArray(raw.content)
          && raw.content.some((part) => part !== null && typeof part === 'object'
            && (part.type === 'input_image' || part.type === 'image_url' || part.image_url !== undefined));
        // 需要先把 chat 形状的 part 归一成 DSH ContentBlock，图片才能被后续提取。
        const content = structured
          ? raw.content.map((part) => {
              if (part !== null && typeof part === 'object'
                  && (part.type === 'input_image' || part.type === 'image_url' || part.image_url !== undefined)) {
                const raw0 = typeof part.image_url === 'object' && part.image_url !== null
                  ? part.image_url.url
                  : part.image_url;
                return { type: 'image-url', url: raw0 };
              }
              const text = contentToText([part]);
              return textBlock(text);
            })
          : [textBlock(contentToText(raw.content) || '(no output)')];
        messages.push({
          id: uuid(),
          role: 'tool',
          content,
          source: { kind: 'tool', callId },
          toolCallId: callId,
        });
        break;
      }
      default:
        messages.push({
          id: uuid(),
          role: 'user',
          content: contentToBlocks(raw.content),
          source: { kind: 'user' },
        });
        break;
    }
  }
  repairToolPairing(messages);
  guardEmptyTextParts(messages);
  return messages;
}

/**
 * Responses API `input` -> Chat Completions messages, then -> DSH messages.
 *
 * A Responses turn splits assistant output into several items:
 *   {type:'message', role:'assistant', content:[...]}
 *   {type:'function_call', call_id, name, arguments}
 *   {type:'function_call_output', call_id, output}
 * The function_call MUST be merged with the same-turn assistant text into one
 * assistant message containing both text and tool-call blocks; otherwise the
 * upstream sees an unmatched tool result and returns 11148.
 */
/**
 * 把 chat 形状里的内联图片落成 DSH 附件，并把它们从原来的消息里摘出来，
 * 另起一条 user 消息把图送上去。
 *
 * 为什么必须另起一条：DSH 的 `tool` 消息不能带 image block
 * （pi-ai 的 assertSupportedHistory 会直接抛 UNSUPPORTED_CONTENT），
 * 而工具返回截图是很常见的（view_image / 截图工具）。参考实现
 * misakano7545/workbuddy2api-panel 也是这么做的：图片攒到「本轮工具结果结束」
 * 之后再发一条 user 消息，避免插在并行 tool 结果之间打断配对（上游判 11148）。
 *
 * 没有 attachments 服务时，退化为占位文本——模型看不到图，但请求不会炸。
 */
async function materializeImages(chatMessages, options = {}) {
  const attachments = options.attachments;
  /** 待发的图片：{ mediaType, bytes } */
  const pending = [];

  const extract = (content) => {
    if (!Array.isArray(content)) return content;
    const kept = [];
    for (const part of content) {
      if (part === null || typeof part !== 'object') continue;
      // 'image-url' 是 chatMessagesToDsh 内部为「还没存成附件的内联图」打的标记。
      if (part.type === 'image-url') {
        const parsed = typeof part.url === 'string' ? parseDataUrl(part.url) : undefined;
        if (parsed !== undefined && attachments !== undefined) {
          pending.push(parsed);
          continue;
        }
        kept.push(textBlock(imagePlaceholder(part.url, '图片')));
        continue;
      }
      if (part.type === 'input_image' || part.type === 'image_url') {
        const raw = typeof part.image_url === 'object' && part.image_url !== null
          ? part.image_url.url
          : part.image_url;
        const parsed = typeof raw === 'string' ? parseDataUrl(raw) : undefined;
        if (parsed !== undefined && attachments !== undefined) {
          pending.push(parsed);
          continue;
        }
        // 没有附件服务、或不是 data URL：留占位文本。
        kept.push({ type: 'text', text: imagePlaceholder(raw, '图片') });
        continue;
      }
      kept.push(part);
    }
    return kept;
  };

  const out = [];
  for (const message of chatMessages) {
    if (Array.isArray(message.content)) {
      const before = message.content.length;
      message.content = extract(message.content);
      // 图片被全部摘走后 tool 消息会变成空的 —— 上游不接受空 tool 结果。
      if (message.role === 'tool' && message.content.length === 0 && before > 0) {
        message.content = [{ type: 'text', text: '(see image below)' }];
      }
    } else if (typeof message.content === 'string' && /data:image\//iu.test(message.content)) {
      message.content = imagePlaceholder(message.content, '图片');
    }
    out.push(message);
  }

  // 全部是文本时没有图片要送，直接返回。
  if (pending.length === 0) return out;

  // 把收集到的图落成附件。
  const blocks = [];
  for (const img of pending) {
    try {
      const ref = await attachments.saveImage({
        data: img.bytes,
        mediaType: img.mediaType,
        name: `gateway-image-${Date.now()}`,
      });
      blocks.push({ type: 'image', attachment: ref });
    } catch (error) {
      // 单张图存不进去不该整轮失败：换成占位文本继续。
      blocks.push({ type: 'text', text: imagePlaceholder(undefined, '图片') });
      void error;
    }
  }

  out.push({
    id: uuid(),
    role: 'user',
    content: [{ type: 'text', text: TOOL_IMAGE_PLACEHOLDER }, ...blocks],
    source: { kind: 'user' },
  });
  return out;
}

export function responsesToDsh(request, options = {}) {
  const chatMessages = [];
  if (typeof request.instructions === 'string' && request.instructions.trim() !== '') {
    chatMessages.push({ role: 'system', content: request.instructions });
  }
  const input = request.input;
  if (typeof input === 'string') {
    if (input.trim() !== '') chatMessages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (item === null || typeof item !== 'object') continue;

      if (item.type === 'reasoning') continue; // upstream-private encrypted payload

      if (item.type === 'function_call') {
        const callId = typeof item.call_id === 'string' && item.call_id !== '' ? item.call_id : uuid();
        const call = {
          id: callId,
          type: 'function',
          function: {
            name: typeof item.name === 'string' ? item.name : '',
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        };
        const last = chatMessages[chatMessages.length - 1];
        if (last !== undefined && last.role === 'assistant') {
          last.tool_calls = last.tool_calls ?? [];
          last.tool_calls.push(call);
        } else {
          chatMessages.push({ role: 'assistant', content: '', tool_calls: [call] });
        }
        continue;
      }

      if (item.type === 'function_call_output') {
        const callId = typeof item.call_id === 'string' ? item.call_id : uuid();
        // 工具返回值可能是字符串，也可能是内容块数组（工具截了图就是这样）。
        // 数组**原样保留**：图片要在 materializeImages 里落成附件、另发一条
        // user 消息，模型才看得到图；这里提前转文本会把图丢掉。
        const output = item.output === undefined || item.output === null
          ? '(no output)'
          : item.output;
        chatMessages.push({ role: 'tool', tool_call_id: callId, content: output });
        continue;
      }

      if (item.type === 'message' || typeof item.role === 'string') {
        const role = item.role ?? 'user';
        if (role === 'user' || role === 'assistant' || role === 'system' || role === 'developer') {
          // 同样剥离内联图片：用户贴图时 content 里也是有 base64 的 part。
          const content = Array.isArray(item.content)
            ? contentToText(item.content, '图片')
            : item.content ?? '';
          chatMessages.push({ role, content });
        }
      }
    }
  }
  return chatMessagesToDsh(chatMessages, options);
}

/** Keep tool calls and their results paired; drop orphan tool results. */
/**
 * 出站前的配对修复。参考实现（misakano7545/workbuddy2api-panel）踩过的坑，
 * 这里逐条对齐：
 *
 *  1. **孤儿 tool 结果**：历史里有结果、没有对应的 assistant tool-call
 *     （客户端截断、或调用被上一轮压缩吃掉）→ 删除，否则上游 11148。
 *  2. **缺结果的 tool-call**：调用发出去了、结果没回来 → 补一条占位结果，
 *     维持成对；不补的话上游同样判 11148。
 *  3. **顺序颠倒**：function_call_output 排在 function_call 之前（Codex 经本地
 *     代理转发时会出现）→ 把 tool 消息挪到发起调用的 assistant 之后。
 *  4. **并行调用之间插进了别的消息**：tool 结果必须紧跟在那条 assistant 后面，
 *     中间插入 user/system 会打断配对。
 */
function repairToolPairing(messages) {
  // 先补缺结果的调用，再挪顺序，最后删孤儿——顺序敏感。
  const callIndex = new Map(); // callId -> 发起它的 assistant 下标
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    for (const block of message.content ?? []) {
      if (block.type === 'tool-call') callIndex.set(block.id, i);
    }
  }

  const answered = new Set();
  for (const message of messages) {
    if (message.role === 'tool') answered.add(message.toolCallId);
  }

  // 2. 缺结果 → 补占位，紧跟在那条 assistant 之后（逆序插入保证下标不乱）
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const missing = (message.content ?? [])
      .filter((block) => block.type === 'tool-call' && !answered.has(block.id))
      .map((block) => block.id);
    if (missing.length === 0) continue;
    const placeholders = missing.map((callId) => ({
      id: uuid(),
      role: 'tool',
      content: [textBlock('(tool call was interrupted before it returned)')],
      source: { kind: 'tool', callId },
      toolCallId: callId,
      isError: true,
    }));
    messages.splice(i + 1, 0, ...placeholders);
    for (const callId of missing) answered.add(callId);
  }

  // 1. 孤儿结果 → 删
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'tool' && !callIndex.has(message.toolCallId)) {
      messages.splice(i, 1);
    }
  }

  // 3 + 4. 重排：每条 tool 消息搬到它那条 assistant 之后，按原相对顺序排列
  const toolBuckets = new Map(); // assistant 下标 -> tool 消息数组
  const rest = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const owner = callIndex.get(message.toolCallId);
      if (owner === undefined) continue;
      const bucket = toolBuckets.get(owner) ?? [];
      bucket.push(message);
      toolBuckets.set(owner, bucket);
    } else {
      rest.push(message);
    }
  }
  if (toolBuckets.size === 0) return messages;

  const rebuilt = [];
  for (let i = 0; i < rest.length; i += 1) {
    rebuilt.push(rest[i]);
    // 找到这条 assistant 在原 messages 里的下标，取它对应的 tool 结果
    const originalIndex = messages.indexOf(rest[i]);
    const bucket = toolBuckets.get(originalIndex);
    if (bucket !== undefined) rebuilt.push(...bucket);
  }
  messages.length = 0;
  messages.push(...rebuilt);
  return messages;
}

/**
 * 空 text 段补位（上游 400 / code 11151 "a message has empty content"）。
 *
 * 上游对每个 text 段做长度校验，`text` 为空串或缺失就整条消息判空。这条错误
 * **不可自愈**：客户端每次重试都重放同一段历史，轮换账号也白撞。
 *
 * 修法是只补值、不删段：空 text 填一个空格（上游只看长度是否为零，"   " 实测放行）。
 * 删段会改段落数量与下标，而多模态顺序、工具结果的段序可能被别处引用。
 */
function guardEmptyTextParts(messages) {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'text' && (typeof block.text !== 'string' || block.text === '')) {
        block.text = ' ';
      }
    }
    // 整条消息一个块都没有也补一个空格，避免「空 content」
    if (message.content.length === 0) {
      message.content = [textBlock(' ')];
    }
  }
  return messages;
}

/** OpenAI tools (both shapes) -> DSH ToolSchema[]. */
function toolsToDsh(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue;
    if (tool.type !== 'function' && tool.type !== undefined) continue;
    const fn = tool.function ?? tool;
    if (typeof fn?.name !== 'string' || fn.name === '') continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: fn.parameters !== null && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
    });
  }
  return out.length > 0 ? out : undefined;
}

/* ------------------------------------------------------------------ *
 * Stream accumulation: DSH StreamChunk -> wire results
 * ------------------------------------------------------------------ */

/** Accumulate a full DSH stream into text / reasoning / tool calls / usage / finish. */
async function collectStream(stream) {
  const result = { text: '', reasoning: '', toolCalls: new Map(), usage: undefined, finish: undefined };
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue;
    switch (chunk.type) {
      case 'text-delta':
        if (typeof chunk.text === 'string') result.text += chunk.text;
        break;
      case 'reasoning-delta':
        if (typeof chunk.text === 'string') result.reasoning += chunk.text;
        break;
      case 'tool-call-delta': {
        const id = chunk.id ?? uuid();
        const call = result.toolCalls.get(id) ?? { id, type: 'function', function: { name: '', arguments: '' } };
        if (typeof chunk.name === 'string' && chunk.name !== '') call.function.name = chunk.name;
        if (typeof chunk.argumentsDelta === 'string') call.function.arguments += chunk.argumentsDelta;
        result.toolCalls.set(id, call);
        break;
      }
      case 'block-end': {
        const block = chunk.block;
        if (block !== null && typeof block === 'object' && block.type === 'tool-call') {
          const id = block.id ?? uuid();
          result.toolCalls.set(id, {
            id,
            type: 'function',
            function: {
              name: typeof block.name === 'string' ? block.name : '',
              arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
            },
          });
        }
        break;
      }
      case 'usage':
        result.usage = {
          prompt_tokens: chunk.usage?.inputTokens ?? 0,
          completion_tokens: chunk.usage?.outputTokens ?? 0,
          total_tokens: chunk.usage?.totalTokens ??
            ((chunk.usage?.inputTokens ?? 0) + (chunk.usage?.outputTokens ?? 0)),
        };
        break;
      case 'finish':
        result.finish = chunk.reason;
        break;
      default:
        break;
    }
  }
  result.toolCalls = [...result.toolCalls.values()];
  return result;
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message, type = 'invalid_request_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}

async function readJson(request) {
  const text = await request.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(error) {
  if (error instanceof HttpError) {
    return json({ error: { message: error.message, type: error.type } }, error.status);
  }
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: { message, type: 'api_error' } }, 500);
}

function sseResponse(body) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

function sseChunk(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function sseEvent(type, value) {
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function responseId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

/* ------------------------------------------------------------------ *
 * Chat Completions translators
 * ------------------------------------------------------------------ */

function chatCompletionNonStream(model, collected) {
  const message = { role: 'assistant', content: collected.text };
  if (collected.reasoning !== '') message.reasoning_content = collected.reasoning;
  if (collected.toolCalls.length > 0) message.tool_calls = collected.toolCalls;
  return {
    id: responseId('chatcmpl'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReasonOf(collected.finish) }],
    ...(collected.usage === undefined ? {} : { usage: collected.usage }),
  };
}

/**
 * Stream Chat Completions. First frame is the assistant role, then incremental
 * content / reasoning / tool_calls, then finish_reason, then [DONE].
 */
export async function handleChatStream(model, stream, sink) {
  const id = responseId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);
  const toolIndex = new Map();
  let nextToolIndex = 0;
  let roleSent = false;
  let usage;
  let finish;
  const base = (delta, finishReason = null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  });
  const ensureRole = () => {
    if (roleSent) return;
    roleSent = true;
    sink.write(sseChunk(base({ role: 'assistant', content: '' })));
  };

  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue;
    switch (chunk.type) {
      case 'text-delta':
        if (typeof chunk.text === 'string' && chunk.text !== '') {
          ensureRole();
          sink.write(sseChunk(base({ content: chunk.text })));
        }
        break;
      case 'reasoning-delta':
        if (typeof chunk.text === 'string' && chunk.text !== '') {
          ensureRole();
          sink.write(sseChunk(base({ reasoning_content: chunk.text })));
        }
        break;
      case 'tool-call-delta': {
        ensureRole();
        let index = toolIndex.get(chunk.id);
        if (index === undefined) {
          index = nextToolIndex;
          nextToolIndex += 1;
          toolIndex.set(chunk.id, index);
        }
        const call = { index, id: chunk.id, type: 'function', function: {} };
        if (typeof chunk.name === 'string' && chunk.name !== '') call.function.name = chunk.name;
        if (typeof chunk.argumentsDelta === 'string') call.function.arguments = chunk.argumentsDelta;
        sink.write(sseChunk(base({ tool_calls: [call] })));
        break;
      }
      case 'block-end': {
        const block = chunk.block;
        if (block !== null && typeof block === 'object' && block.type === 'tool-call') {
          ensureRole();
          const id2 = block.id ?? chunk.id ?? uuid();
          let index = toolIndex.get(id2);
          if (index === undefined) {
            index = nextToolIndex;
            nextToolIndex += 1;
            toolIndex.set(id2, index);
          }
          sink.write(sseChunk(base({
            tool_calls: [{
              index,
              id: id2,
              type: 'function',
              function: {
                name: typeof block.name === 'string' ? block.name : '',
                arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
              },
            }],
          })));
        }
        break;
      }
      case 'usage':
        usage = {
          prompt_tokens: chunk.usage?.inputTokens ?? 0,
          completion_tokens: chunk.usage?.outputTokens ?? 0,
          total_tokens: chunk.usage?.totalTokens ??
            ((chunk.usage?.inputTokens ?? 0) + (chunk.usage?.outputTokens ?? 0)),
        };
        break;
      case 'finish':
        finish = chunk.reason;
        break;
      default:
        break;
    }
  }
  ensureRole();
  // 与非流式路径保持一致：上游失败要说出来，不能发 finish_reason=stop
  // 让客户端以为"这回合的答案就是空的"。
  const failure = failureOf(finish);
  if (failure !== undefined) {
    sink.write(sseChunk({
      error: {
        message: failure.message ?? 'upstream failed',
        type: 'api_error',
        code: failure.code ?? 'UPSTREAM_ERROR',
      },
    }));
    sink.write('data: [DONE]\n\n');
    return;
  }
  sink.write(sseChunk(base({}, finishReasonOf(finish))));
  sink.write('data: [DONE]\n\n');
}

/* ------------------------------------------------------------------ *
 * Responses translators
 * ------------------------------------------------------------------ */

function responsesShell(id, model, created, status, output, usage) {
  return {
    id,
    object: 'response',
    created_at: created,
    status,
    model,
    output,
    usage,
  };
}

/** 失败态的 response 外壳，交给 response.failed 使用。 */
function failedShell(id, model, created, failure) {
  return {
    id,
    object: 'response',
    created_at: created,
    status: 'failed',
    model,
    output: [],
    usage: null,
    error: {
      message: failure?.message ?? 'upstream failed',
      code: failure?.code ?? 'UPSTREAM_ERROR',
    },
  };
}

function responsesNonStream(model, collected) {
  const output = [];
  if (collected.reasoning !== '') {
    output.push({
      type: 'reasoning',
      id: responseId('rs'),
      status: 'completed',
      summary: [{ type: 'summary_text', text: collected.reasoning }],
    });
  }
  if (collected.text !== '') {
    output.push({
      type: 'message',
      id: responseId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: collected.text, annotations: [] }],
    });
  }
  for (const call of collected.toolCalls) {
    output.push({
      type: 'function_call',
      id: responseId('fc'),
      status: 'completed',
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }
  const usage = collected.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return responsesShell(
    responseId('resp'),
    model,
    Math.floor(Date.now() / 1000),
    'completed',
    output,
    { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens },
  );
}

/**
 * Stream Responses events in order:
 *   response.created -> output_item.added -> output_text.delta ->
 *   output_item.done -> response.completed
 * (plus reasoning and function-call argument events where relevant).
 */
export async function handleResponsesStream(model, stream, sink) {
  const id = responseId('resp');
  const created = Math.floor(Date.now() / 1000);
  const items = [];
  let sequence = 0;
  const emit = (type, payload) => {
    sequence += 1;
    sink.write(sseEvent(type, { type, sequence_number: sequence, ...payload }));
  };
  const shell = (status, output, usage) => responsesShell(id, model, created, status, output, usage);

  emit('response.created', { response: shell('in_progress', [], null) });

  let textItem;
  let reasonItem;
  const toolItems = new Map();
  let text = '';
  let reasoning = '';
  let usage;
  let finish;

  const openText = () => {
    if (textItem !== undefined) return;
    textItem = { index: items.length, id: responseId('msg') };
    items.push({
      type: 'message', id: textItem.id, status: 'in_progress', role: 'assistant', content: [],
    });
    emit('response.output_item.added', { output_index: textItem.index, item: items[textItem.index] });
    emit('response.content_part.added', {
      item_id: textItem.id,
      output_index: textItem.index,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };
  const openReason = () => {
    if (reasonItem !== undefined) return;
    reasonItem = { index: items.length, id: responseId('rs') };
    items.push({ type: 'reasoning', id: reasonItem.id, status: 'in_progress', summary: [] });
    emit('response.output_item.added', { output_index: reasonItem.index, item: items[reasonItem.index] });
  };
  const openTool = (callId, name) => {
    let state = toolItems.get(callId);
    if (state !== undefined) return state;
    state = { index: items.length, id: responseId('fc'), callId, name: name ?? '', args: '' };
    toolItems.set(callId, state);
    items.push({
      type: 'function_call',
      id: state.id,
      status: 'in_progress',
      call_id: state.callId,
      name: state.name,
      arguments: '',
    });
    emit('response.output_item.added', { output_index: state.index, item: items[state.index] });
    return state;
  };

  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue;
    switch (chunk.type) {
      case 'error': {
        // 有些适配器把失败作为 chunk 抛出而不是 finish。
        const failure = failureOf({ kind: 'error', failure: chunk.failure ?? chunk.error });
        emit('response.failed', { response: failedShell(id, model, created, failure) });
        return;
      }
      case 'text-delta':
        if (typeof chunk.text === 'string' && chunk.text !== '') {
          openText();
          text += chunk.text;
          emit('response.output_text.delta', {
            item_id: textItem.id, output_index: textItem.index, content_index: 0, delta: chunk.text,
          });
        }
        break;
      case 'reasoning-delta':
        if (typeof chunk.text === 'string' && chunk.text !== '') {
          openReason();
          reasoning += chunk.text;
          emit('response.reasoning_summary_text.delta', {
            item_id: reasonItem.id, output_index: reasonItem.index, summary_index: 0, delta: chunk.text,
          });
        }
        break;
      case 'tool-call-delta': {
        const callId = chunk.id ?? uuid();
        const state = openTool(callId, chunk.name);
        if (typeof chunk.name === 'string' && chunk.name !== '' && state.name === '') {
          state.name = chunk.name;
          items[state.index].name = chunk.name;
        }
        if (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '') {
          state.args += chunk.argumentsDelta;
          emit('response.function_call_arguments.delta', {
            item_id: state.id, output_index: state.index, delta: chunk.argumentsDelta,
          });
        }
        break;
      }
      case 'block-end': {
        const block = chunk.block;
        if (block !== null && typeof block === 'object' && block.type === 'tool-call') {
          const callId = block.id ?? uuid();
          const state = openTool(callId, block.name);
          const args = typeof block.arguments === 'string'
            ? block.arguments
            : JSON.stringify(block.arguments ?? {});
          if (typeof block.name === 'string' && block.name !== '') {
            state.name = block.name;
            items[state.index].name = block.name;
          }
          if (args !== state.args) {
            state.args = args;
            emit('response.function_call_arguments.delta', {
              item_id: state.id, output_index: state.index, delta: args,
            });
          }
        }
        break;
      }
      case 'usage':
        usage = chunk.usage;
        break;
      case 'finish':
        finish = chunk.reason;
        break;
      default:
        break;
    }
  }

  // output_item.done for each item, in creation order.
  if (reasonItem !== undefined) {
    items[reasonItem.index].status = 'completed';
    items[reasonItem.index].summary = [{ type: 'summary_text', text: reasoning }];
    emit('response.output_item.done', { output_index: reasonItem.index, item: items[reasonItem.index] });
  }
  if (textItem !== undefined) {
    items[textItem.index].status = 'completed';
    items[textItem.index].content = [{ type: 'output_text', text, annotations: [] }];
    emit('response.output_text.done', {
      item_id: textItem.id, output_index: textItem.index, content_index: 0, text,
    });
    emit('response.output_item.done', { output_index: textItem.index, item: items[textItem.index] });
  }
  for (const state of toolItems.values()) {
    items[state.index].status = 'completed';
    items[state.index].arguments = state.args;
    emit('response.function_call_arguments.done', {
      item_id: state.id, output_index: state.index, arguments: state.args,
    });
    emit('response.output_item.done', { output_index: state.index, item: items[state.index] });
  }

  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const tokenUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage?.totalTokens ?? (inputTokens + outputTokens),
  };

  // 上游失败必须说清楚。此前这里无条件发 response.completed：一次"余额不足 /
  // 配额用尽 / 上游异常"会被 Codex 读成"成功但内容为空"，界面上表现为模型
  // 突然不说话了，与真正的空回答无法区分。非流式路径一直有检查，流式漏了。
  const failure = failureOf(finish);
  if (failure !== undefined) {
    emit('response.failed', { response: failedShell(id, model, created, failure) });
    return;
  }

  /**
   * 空回答判据：无正文、无工具调用、只有思考、且不是被长度截断。
   *
   * 为什么必须判成失败而不是完成：发 response.completed 等于告诉 Codex
   * 「模型想完了、没什么要说的」，Agent 就此收尾，用户看到一条空回复、
   * 只能自己再催一句。这是 deepseek/glm 系在 effort=max 下的高频形态
   * （参考实现实测 think/completion 可到 0.93）。
   *
   * 截断（max-tokens）不在此列：那是 incomplete，客户端会按自己的策略处理。
   */
  const hasText = items.some((item) => item.type === 'message'
    && (item.content ?? []).some((part) => typeof part.text === 'string' && part.text.trim() !== ''));
  const hasToolCall = items.some((item) => item.type === 'function_call');
  const hasReasoning = items.some((item) => item.type === 'reasoning'
    && (item.summary ?? []).some((part) => typeof part.text === 'string' && part.text.trim() !== ''));
  const truncated = finish?.reason?.kind === 'max-tokens';
  if (!hasText && !hasToolCall && hasReasoning && !truncated) {
    emit('response.failed', {
      response: failedShell(id, model, created, {
        message: 'upstream returned reasoning without output text; retry',
        code: 'empty_reasoning_only',
      }),
    });
    return;
  }

  emit('response.completed', { response: shell('completed', items, tokenUsage) });
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);

  // 附件服务（可选）：用来把工具返回的内联图片落成真实附件，让模型看得到图。
  // 没有它时图片退化成占位文本，请求仍然可用。
  const attachmentsService = (() => {
    try {
      return ctx.get('attachments');
    } catch {
      return undefined;
    }
  })();
  // DSH 桌面端的 stderr 不落文件，日志写到固定位置便于排障。
  const log = (message) => {
    try {
      appendFileSync('/tmp/dsh-llm-gateway.log', `[${new Date().toISOString()}] ${message}\n`);
    } catch { /* 日志失败不影响主流程 */ }
  };

  let cache = [];
  let cacheAt = 0;
  let inflight = null;

  async function loadModels() {
    const providerIds = ctx.llm.listProviders().map((entry) =>
      typeof entry === 'string' ? entry : entry?.id,
    ).filter((id) => typeof id === 'string' && id !== '');
    const entries = [];
    for (const provider of providerIds) {
      try {
        const models = await ctx.llm.listModels(provider);
        for (const model of models) {
          if (model === null || typeof model !== 'object') continue;
          // listModels 只给 id/name；上下文窗口与推理档位要单独解析。
          // 不解析的话，Codex 目录只能拿 272000/medium 这类模板值兜底，
          // 与模型真实能力不符（Hy4 标称 960K、DeepSeek 标称 1M）。
          let detail = model;
          try {
            detail = await ctx.llm.resolveModelInfo(provider, model.id);
          } catch (error) {
            log(`resolveModelInfo(${provider}/${model.id}) failed: ${String(error)}`);
          }
          const entry = {
            provider,
            model: model.id,
            name: detail?.name ?? model.name ?? model.id,
            group: groupOf(provider),
            contextWindow: detail?.context?.contextWindow,
            maxTokens: detail?.defaultMaxTokens,
            efforts: Array.isArray(detail?.reasoning?.efforts)
              ? detail.reasoning.efforts.map((e) => (typeof e === 'string' ? e : e?.id)).filter((x) => typeof x === 'string' && x !== '')
              : [],
            defaultEffort: detail?.reasoning?.defaultEffort,
          };
          // 档位对外只暴露槽位；slotMap 记录「槽位 → 上游真档位」的换算。
          const { slots, map: slotMap } = slotize(entry.efforts);
          // 默认槽位：把上游的默认真档位反查回它的槽位。
          // 注意不能用 indexOf 直接套在 slots 上——slots 与 efforts 长度可能
          // 不同（超长档位表会等距抽样），必须先在 efforts 里定位再换算。
          let slotDefault;
          if (slots.length === 0) {
            slotDefault = undefined;
          } else {
            const pos = entry.efforts.indexOf(entry.defaultEffort);
            if (pos === -1) {
              slotDefault = slots[slots.length - 1];
            } else if (entry.efforts.length === slots.length) {
              slotDefault = slots[pos];
            } else {
              // 抽样情形：找覆盖该真档位的最近槽位
              let best = 0;
              let bestDist = Infinity;
              const last = slots.length - 1;
              for (let i = 0; i < slots.length; i += 1) {
                const idx = Math.round((i * (entry.efforts.length - 1)) / last);
                const d = Math.abs(idx - pos);
                if (d < bestDist) {
                  bestDist = d;
                  best = i;
                }
              }
              slotDefault = slots[best];
            }
          }
          entries.push({
            ...entry,
            publicId: publicIdOf(entry),
            slotMap,
            slots,
            slotDefault,
          });
        }
      } catch (error) {
        log(`listModels(${provider}) failed: ${String(error)}`);
      }
    }
    cache = entries;
    cacheAt = Date.now();
    return entries;
  }

  async function listModels() {
    if (inflight !== null) return inflight;
    if (cacheAt !== 0 && Date.now() - cacheAt < CACHE_MS) return cache;
    inflight = loadModels().finally(() => { inflight = null; });
    return inflight;
  }

  /** Route resolution with the required precedence and ambiguity diagnostics. */
  async function resolveRoute(wireId) {
    if (typeof wireId !== 'string' || wireId === '') {
      throw new HttpError(400, 'model is required', 'invalid_request_error');
    }
    const models = await listModels();

    // 1. Exact public id match.
    const exact = models.filter((entry) => entry.publicId === wireId);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new HttpError(400, `ambiguous model "${wireId}": ${exact.map((m) => `${m.provider}/${m.model}`).join(', ')}`);
    }

    // 2. Raw model id match (allows bypassing grouping).
    const raw = models.filter((entry) => entry.model === wireId);
    if (raw.length === 1) return raw[0];
    if (raw.length > 1) {
      throw new HttpError(400, `ambiguous model "${wireId}": candidates ${raw.map((m) => m.provider).join(', ')}`);
    }

    // 3. "<provider>/<model>" split fallback.
    const slash = wireId.indexOf('/');
    if (slash > 0) {
      const provider = wireId.slice(0, slash);
      const model = wireId.slice(slash + 1);
      if (GROUP_PREFIXES.has(provider)) {
        throw new HttpError(
          400,
          `"${provider}" is a group prefix, not a provider; use one of the public ids from GET /v1/models`,
        );
      }
      const split = models.filter((entry) => entry.provider === provider && entry.model === model);
      if (split.length === 1) return split[0];
      if (split.length > 1) {
        throw new HttpError(400, `ambiguous model "${wireId}": candidates ${split.map((m) => m.provider).join(', ')}`);
      }
    }

    throw new HttpError(404, `unknown model "${wireId}"; call GET /v1/models for the available ids`);
  }

  /**
   * Build GenerateOptions from a wire request. Shared by both endpoints so all
   * calls end up as `ctx.llm.stream({ provider, model, messages, system, tools })`.
   */
  async function buildOptions(body, messages, requestedSlot) {
    const route = await resolveRoute(body.model);
    // 槽位 → 上游真档位。客户端说的是槽位名（low/medium/…），
    // 上游要的是它自己声明的名字（none/minimal/low/high/max…）。
    const effort = resolveSlot(route, requestedSlot);
    const options = {
      provider: route.provider,
      model: route.model,
      messages,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(typeof body.max_tokens === 'number' ? { maxTokens: body.max_tokens } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    };
    const tools = toolsToDsh(body.tools);
    if (tools !== undefined) options.tools = tools;
    return { route, options };
  }

  /** 从两种 wire 形状里取出客户端选的档位：Chat 用顶层，Responses 用 reasoning.effort。 */
  function requestedEffortOf(body) {
    if (typeof body?.reasoning_effort === 'string' && body.reasoning_effort !== '') {
      return body.reasoning_effort;
    }
    const nested = body?.reasoning;
    if (nested !== null && typeof nested === 'object' && typeof nested.effort === 'string' && nested.effort !== '') {
      return nested.effort;
    }
    return undefined;
  }

  function authorized(request) {
    if (config.apiKey === '') return true;
    return request.headers.get('authorization') === `Bearer ${config.apiKey}`;
  }

  async function handle(request) {
    // `request` is a Web Request (absolute url) built in createServer below.
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/u, '') || '/';

    if (!authorized(request)) {
      return json({ error: { message: 'missing or invalid bearer token', type: 'authentication_error' } }, 401);
    }

    if (request.method === 'GET' && path === '/healthz') {
      const models = await listModels();
      return json({ ok: true, service: name, models: models.length });
    }

    if (request.method === 'GET' && path === '/v1/models') {
      const models = await listModels();
      return json({
        object: 'list',
        data: models.map((entry) => ({
          id: entry.publicId,
          object: 'model',
          created: 0,
          owned_by: entry.group,
          name: entry.name,
          // 下游（Codex 目录生成器）靠这几个字段决定窗口与默认档位。
          context_length: entry.contextWindow,
          max_output_tokens: entry.maxTokens,
          // 对外只给槽位名：数量与上游档位数一致，顺序一一对应。
          reasoning_supported_efforts: entry.slots,
          reasoning_default_effort: entry.slotDefault,
        })),
      });
    }

    if (request.method === 'POST' && path === '/v1/chat/completions') {
      const body = await readJson(request);
      let messages = chatMessagesToDsh(body.messages, { provider: 'gateway', model: body.model });
      messages = await materializeImages(messages, { attachments: attachmentsService });
      if (messages.length === 0) throw new HttpError(400, 'messages must not be empty');
      const { route, options } = await buildOptions(body, messages, requestedEffortOf(body));

      if (body.stream === true) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            const sink = {
              write(text) {
                try { controller.enqueue(encoder.encode(text)); } catch { /* client gone */ }
              },
            };
            (async () => {
              try {
                await handleChatStream(body.model, ctx.llm.stream(options), sink);
              } catch (error) {
                const failure = failureOf(error?.reason) ?? { message: String(error) };
                sink.write(sseChunk({
                  error: { message: failure.message ?? String(error), type: 'api_error' },
                }));
                sink.write('data: [DONE]\n\n');
              } finally {
                try { controller.close(); } catch { /* already closed */ }
              }
            })();
          },
        });
        return sseResponse(stream);
      }

      const collected = await collectStream(ctx.llm.stream(options));
      const failure = failureOf(collected.finish);
      // 非流式的空回答判据：只有思考、没有正文与工具调用 → 502，
      // 让客户端按自己的重试策略重来，而不是拿到一个「成功但 output 全空」的对象。
      const reasoningOnly = collected.text === ''
        && collected.toolCalls.length === 0
        && typeof collected.reasoning === 'string'
        && collected.reasoning.trim() !== ''
        && collected.finish?.reason?.kind !== 'max-tokens';
      if (reasoningOnly) {
        throw new HttpError(502, 'upstream returned reasoning without output text; retry', 'empty_reasoning_only');
      }
      if (failure !== undefined && collected.text === '' && collected.toolCalls.length === 0) {
        throw new HttpError(502, failure.message ?? 'upstream failed', 'api_error');
      }
      return json(chatCompletionNonStream(body.model, collected));
    }

    if (request.method === 'POST' && path === '/v1/responses') {
      const body = await readJson(request);
      let messages = responsesToDsh(body, { provider: 'gateway', model: body.model });
      messages = await materializeImages(messages, { attachments: attachmentsService });
      if (messages.length === 0) throw new HttpError(400, 'input must not be empty');
      const bodyForOptions = {
        ...body,
        tools: body.tools,
        max_tokens: body.max_output_tokens,
      };
      const { route, options } = await buildOptions(bodyForOptions, messages, requestedEffortOf(body));

      if (body.stream === true) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            const sink = {
              write(text) {
                try { controller.enqueue(encoder.encode(text)); } catch { /* client gone */ }
              },
            };
            (async () => {
              try {
                await handleResponsesStream(body.model, ctx.llm.stream(options), sink);
              } catch (error) {
                sink.write(sseEvent('response.failed', {
                  response: {
                    id: responseId('resp'),
                    object: 'response',
                    status: 'failed',
                    model: body.model,
                    error: { message: String(error), code: 'upstream_error' },
                  },
                }));
              } finally {
                try { controller.close(); } catch { /* already closed */ }
              }
            })();
          },
        });
        return sseResponse(stream);
      }

      const collected = await collectStream(ctx.llm.stream(options));
      const failure = failureOf(collected.finish);
      // 非流式的空回答判据：只有思考、没有正文与工具调用 → 502，
      // 让客户端按自己的重试策略重来，而不是拿到一个「成功但 output 全空」的对象。
      const reasoningOnly = collected.text === ''
        && collected.toolCalls.length === 0
        && typeof collected.reasoning === 'string'
        && collected.reasoning.trim() !== ''
        && collected.finish?.reason?.kind !== 'max-tokens';
      if (reasoningOnly) {
        throw new HttpError(502, 'upstream returned reasoning without output text; retry', 'empty_reasoning_only');
      }
      if (failure !== undefined && collected.text === '' && collected.toolCalls.length === 0) {
        throw new HttpError(502, failure.message ?? 'upstream failed', 'api_error');
      }
      return json(responsesNonStream(body.model, collected));
    }

    throw new HttpError(404, `no route for ${request.method} ${path}`, 'not_found_error');
  }

  const server = http.createServer(async (request, response) => {
    let result;
    try {
      // node:http IncomingMessage has no .text(); wrap it as a Web Request.
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
      const absolute = `http://${request.headers.host ?? `${config.host}:${config.port}`}${request.url ?? '/'}`;
      const webRequest = new Request(absolute, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
      });
      result = await handle(webRequest);
    } catch (error) {
      if (process.env.DSH_GATEWAY_DEBUG) process.stderr.write(`${error?.stack ?? String(error)}\n`);
      result = errorResponse(error);
    }
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    if (result.body === null) {
      response.end();
      return;
    }
    const reader = result.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(value);
      }
    } catch {
      /* client disconnected */
    } finally {
      response.end();
    }
  });

  ctx.effect(() => {
    server.listen(config.port, config.host, () => {
      log(`listening on http://${config.host}:${config.port}`);
    });
    return () => server.close();
  });
}
