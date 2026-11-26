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

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8392,
  apiKey: '',
  // 请求体上限。Codex 每轮都会把整段历史重发一遍，带图的会话里 base64 图片
  // 会把这一个请求推到几十 MB —— 默认值必须容得下正常的多图历史。
  maxBodyBytes: 256 * 1024 * 1024,
  // 路由图片预算：与 DSH pi-ai 适配器的默认值对齐，略保守一点。超过时网关自己
  // 省略最老的图片，而不是让适配器抛 IMAGE_OFFLOAD_REQUIRED（见 applyImageBudget）。
  maxRequestImages: 50,
  maxRequestImageBytes: 20 * 1024 * 1024,
};
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
    if (Number.isInteger(raw.maxBodyBytes) && raw.maxBodyBytes > 0) config.maxBodyBytes = raw.maxBodyBytes;
    if (Number.isInteger(raw.maxRequestImages) && raw.maxRequestImages > 0) config.maxRequestImages = raw.maxRequestImages;
    if (Number.isInteger(raw.maxRequestImageBytes) && raw.maxRequestImageBytes > 0) config.maxRequestImageBytes = raw.maxRequestImageBytes;
  }
  return config;
}

/** 字节数 → 便于读的 MB/KB，用于日志。 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * 把入站请求体读完并丢弃。
 *
 * 用途只有一个：我们已经决定拒绝这个请求（例如超限），但客户端还在往上写。
 * 此时直接 break 或 destroy socket 会让客户端看到 broken pipe，具体原因反而
 * 传达不到；读完剩余字节再写响应，客户端才能正常读到 413 和它的错误体。
 *
 * 有上限保护：最多再排空 maxDrainBytes，防止恶意客户端用无限流占住连接。
 */
async function drain(request, maxDrainBytes = 512 * 1024 * 1024) {
  let drained = 0;
  try {
    for await (const chunk of request) {
      drained += chunk.length;
      if (drained > maxDrainBytes) {
        request.destroy();
        return;
      }
    }
  } catch {
    /* 客户端先断了，无所谓 */
  }
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
      continue;
    }
    // Keep image parts so materializeImages() can admit them through DSH's
    // attachment service. Dropping them here made the model report "no image".
    if (part.type === 'input_image' || part.type === 'image_url' || part.image_url !== undefined) {
      const url = typeof part.image_url === 'object' && part.image_url !== null
        ? part.image_url.url
        : part.image_url ?? part.url;
      if (typeof url === 'string' && url !== '') blocks.push({ type: 'image-url', url });
      continue;
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

const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** 拉取远端图片 → { mediaType, bytes }，带超时与硬上限。失败返回 undefined。 */
async function fetchRemoteImage(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return undefined;
    const mediaType = String(res.headers.get('content-type') ?? '').toLowerCase().split(';')[0];
    if (!/^image\/(png|jpeg|webp|gif)$/u.test(mediaType)) return undefined;
    if (Number(res.headers.get('content-length') ?? 0) > IMAGE_MAX_BYTES) return undefined;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) return undefined;
    return { mediaType, bytes };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Classify an upstream failure into an HTTP status plus an actionable hint.
 *
 * workbuddy2api-panel keeps a 19-kind taxonomy and, crucially, does NOT treat
 * request-level failures (bad params, tool mismatch, quota, prompt too long)
 * as account failures: retrying the same body or rotating accounts is useless
 * there. Only account/transport failures get 502/429 and may recover.
 */
/**
 * 把上游失败分类成「HTTP 状态 + 机器码 + 人能照做的一句话」。
 *
 * 提示语的写法参照 `dsh-connect-workbuddy`：它给每条失败都写清三件事——
 * **这是什么**、**和账号/额度有没有关系**、**现在该做什么**。它那句
 * 「这不是账号被限流，也与积分、额度无关——同一凭据下换一个模型即可正常使用；
 * 插件不会为此切换账号，因为该限制跟随模型本身」比一句 "upstream error" 有用得多，
 * 因为读者能据此立刻决定「重发还是换模型还是等」。
 *
 * 这里同样区分「重发有用」与「重发无用」：
 *   - PROMPT_TOO_LONG 重发还是太长 → 要压缩历史或新建任务
 *   - TOOL_MISMATCH   同一份历史重发还是不一致 → 只能新建任务
 *   - CHANNEL_REJECT  按内容拒绝，换账号也一样 → 改系统提示或换模型
 *   - IMAGE_INVALID   图本身坏了 → 换一张小图
 * 这几条都不该让客户端白重试（见 NON_RETRYABLE_CODES）。
 */
function classifyFailure(failure) {
  const code = String(failure?.code ?? '').toUpperCase();
  const message = String(failure?.message ?? '');
  if (code === 'ACCOUNT_QUOTA' || /insufficient balance|credits exhausted|余额不足|额度不足/i.test(message)) {
    return {
      status: 402,
      code: 'ACCOUNT_QUOTA',
      hint: 'The upstream account is out of credit. Top up that account, or switch to another model group; retrying this request will not help.',
    };
  }
  if (code === 'RATE_LIMIT' || /rate limit|quota exceeded|too many requests|429|限流|冷却/i.test(message)) {
    return {
      status: 429,
      code: 'RATE_LIMIT',
      hint: 'The upstream is rate limited or cooling down. Wait for the cooldown to lift, or use another model group; retrying immediately returns the same answer.',
    };
  }
  if (/11148|tool invocation|tool_call.*match|工具调用记录/i.test(message)) {
    return {
      status: 400,
      code: 'TOOL_MISMATCH',
      hint: 'The tool-call history is inconsistent (call without result, or result without call). Start a new task; resending the same history is rejected again.',
    };
  }
  if (/11128|unapproved channel|渠道校验|request illegal/i.test(message)) {
    return {
      status: 400,
      code: 'CHANNEL_REJECT',
      hint: 'The upstream rejected the prompt by content, not by account or quota. Shorten or neutralise the system prompt, or switch models.',
    };
  }
  if (/11135|invalid image|image.*invalid|图片/i.test(message)) {
    return {
      status: 400,
      code: 'IMAGE_INVALID',
      hint: 'The upstream could not read the image. Use a smaller PNG/JPEG/WebP, or remove the image from the request.',
    };
  }
  if (/11115|prompt is too long|context.*exceed|超长|上下文/i.test(message)) {
    return {
      status: 400,
      code: 'PROMPT_TOO_LONG',
      hint: 'The conversation exceeds the model context window. Compact the history or start a new task; the same history will be rejected again.',
    };
  }
  if (/11151|empty content/i.test(message)) {
    return {
      status: 400,
      code: 'EMPTY_CONTENT',
      hint: 'A message had empty content. The gateway pads these before sending, so this came from a shape it could not repair; retry once, then start a new task.',
    };
  }
  return { status: 502, code: failure?.code ?? 'UPSTREAM_ERROR', hint: undefined };
}

/**
 * 这次失败重试有没有意义。
 *
 * 照搬 dsh-connect-workbuddy 的判据哲学：**同一份请求换谁、隔多久都会被同一处
 * 拒绝的失败，不该让客户端反复重试**。那一侧为排队（6020/6021/6022）专门加了
 * `x-should-retry: false`，理由写得很清楚——没有它时 429 会被按状态码无条件重试
 * 五轮、合计约 15 秒，每一次都是真实请求换来同一句「你还在第 8777 位」。
 *
 * 这里的对应关系：
 *   - PROMPT_TOO_LONG  历史太长，重发还是太长 → 不重试，让客户端去压缩/新建任务
 *   - TOOL_MISMATCH    工具历史不一致，同样的历史重发还是不一致 → 不重试
 *   - CHANNEL_REJECT   按内容拒绝，换账号也一样 → 不重试
 *   - IMAGE_INVALID    图片本身坏了 → 不重试
 *   - EMPTY_CONTENT    空段已在出站补位，走到这里说明是请求形态问题 → 不重试
 *   - ACCOUNT_QUOTA    余额/额度耗尽，短时间内不会自己好 → 不重试
 *   - RATE_LIMIT       冷却中，retry-after 才是准的 → 不重试（等提示的时间再发）
 *   - 其余（5xx/网络）  是瞬时故障，**应该**重试 → 不带头
 */
const NON_RETRYABLE_CODES = new Set([
  'PROMPT_TOO_LONG',
  'TOOL_MISMATCH',
  'CHANNEL_REJECT',
  'IMAGE_INVALID',
  'EMPTY_CONTENT',
  'ACCOUNT_QUOTA',
  'RATE_LIMIT',
]);

/** 给一次已分类的失败挑响应头：不可重试的失败要显式说不。 */
function headersForFailure(classified) {
  return NON_RETRYABLE_CODES.has(classified.code) ? NO_RETRY_HEADERS : undefined;
}

/** Build an OpenAI-shaped error object with the classified status and hint. */
function classifiedError(failure) {
  const classified = classifyFailure(failure);
  return {
    status: classified.status,
    headers: headersForFailure(classified),
    body: {
      message: classified.hint
        ? `${failure?.message ?? 'upstream failed'} — ${classified.hint}`
        : failure?.message ?? 'upstream failed',
      type: classified.status >= 500 ? 'server_error' : 'upstream_error',
      code: classified.code,
      gateway_hint: classified.hint,
    },
  };
}

/**
 * DSH TokenUsage -> OpenAI usage。
 *
 * 为什么单列 cache 计数：`dsh-connect-workbuddy` 那侧专门记录过这件事——
 * 缓存命中数在两个网关上用了**两个不同的字段名**（OpenAI 的
 * `prompt_tokens_details.cached_tokens` 与国内网关的 `prompt_cache_hit_tokens`），
 * 只报一个会让另一个区域永远显示 0。这里把 DSH 侧的 `cacheReadTokens` 同时写到
 * 两个位置，下游按哪个读都能读到真实值。
 *
 * `reasoning_tokens` 同理：它是 output 的一部分，但要单列，
 * 否则客户端无法把「思考花掉的钱」和「正文花掉的钱」分开看。
 */
/**
 * OpenAI usage -> Responses 协议的 usage 形状。
 *
 * Responses 用 `input_tokens` / `output_tokens` / `total_tokens`，
 * 缓存计数在 `input_tokens_details.cached_tokens`（与 Chat 的
 * `prompt_tokens_details` 同义不同名）。两处都保留，客户端按自己的协议读。
 */
function responsesUsageToWire(usage) {
  const prompt = usage?.prompt_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  const out = {
    input_tokens: prompt,
    output_tokens: completion,
    total_tokens: usage?.total_tokens ?? prompt + completion,
  };
  const cached = usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.prompt_cache_hit_tokens;
  if (typeof cached === 'number' && cached > 0) {
    out.input_tokens_details = { cached_tokens: cached };
  }
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === 'number' && reasoning > 0) {
    out.output_tokens_details = { reasoning_tokens: reasoning };
  }
  return out;
}

function usageToOpenAI(usage) {
  if (usage === undefined || usage === null) return undefined;
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  const total = usage.totalTokens ?? prompt + completion;
  const cacheRead = usage.cacheReadTokens;
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
  if (typeof cacheRead === 'number' && cacheRead > 0) {
    // 两种拼写都写，见上面的说明。
    out.prompt_tokens_details = { cached_tokens: cacheRead };
    out.prompt_cache_hit_tokens = cacheRead;
  }
  if (typeof usage.reasoningTokens === 'number' && usage.reasoningTokens > 0) {
    out.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  }
  return out;
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
const IMAGE_OFFLOAD_PLACEHOLDER = '[image omitted: over the route image budget]';
const DEFAULT_MAX_REQUEST_IMAGES = 50;
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
/** pi-ai 适配器的单张请求图片编码字节目标（requestImageMaxBytes 的默认值）。 */
const REQUEST_IMAGE_TARGET_BYTES = 1024 * 1024;

/**
 * 按 DSH 的路由预算省略最老的图片。
 *
 * DSH 的 pi-ai 适配器对一条请求有硬预算：最多 `maxRequestImages`（默认 50）张
 * 图片出现，base64 载荷合计不超过 `maxRequestImageBytes`（默认 20 MB）。超了它
 * 抛 `IMAGE_OFFLOAD_REQUIRED`，由 `dsh-compaction-image-offload` 在会话里记一条
 * `image/offload` 事件、把最老的若干位置标记成省略，然后重试。
 *
 * 那条恢复链**只在 DSH 自己的会话里成立**：它靠会话事件记住哪个位置被省略过。
 * 走网关时每一轮都是新的 HTTP 请求，网关每轮原地重建图片块，省略标记无处安放，
 * 于是重试还是同样超限——表现就是 Codex 里反复出现
 * 「stream disconnected before completion: ... N more oldest occurrence(s) must be offloaded」。
 *
 * 所以网关自己按**请求内**的确定性规则做同一件事：从最老的图片开始省略，直到
 * 装进预算。同一份历史每次都会被省略成同一组图片，不依赖跨请求状态。
 *
 * 返回保留的图片下标集合（省略掉的会换成占位文本）。
 */
/**
 * 把请求里的图片压进路由预算，办法是**从最老的开始省略**。
 *
 * 预算按适配器的口径算：每张图按 base64 长度计入（`ceil(bytes/3)*4`），
 * 数量与总字节两条都要满足。留 5% 余量，因为适配器算的是它自己重新编码后的
 * base64，和这里的估计不会逐字节相同。
 *
 * 直接在传入的消息数组上原地改写：被省略的位置换成占位文本。
 */
export function applyImageBudget(messages, limit) {
  const maxImages = Number.isInteger(limit?.maxImages) && limit.maxImages > 0
    ? limit.maxImages
    : DEFAULT_MAX_REQUEST_IMAGES;
  const maxBytes = Number.isInteger(limit?.maxBytes) && limit.maxBytes > 0
    ? limit.maxBytes
    : DEFAULT_MAX_REQUEST_IMAGE_BYTES;
  const bytesBudget = Math.floor(maxBytes * 0.95);

  // 按模型请求顺序收集每个图片出现位置。
  const occurrences = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (let index = 0; index < message.content.length; index += 1) {
      const block = message.content[index];
      if (block?.type !== 'image') continue;
      // 适配器发出的不是上传时的原始字节，而是它按路由目标（默认 1 MiB/张）
      // 重新编码后的结果。用两者的较小值估计，避免高估后多省略本来装得下的图。
      const uploaded = Number(block.attachment?.bytes ?? 0);
      const bytes = Math.min(uploaded, REQUEST_IMAGE_TARGET_BYTES);
      occurrences.push({ message, index, base64: Math.ceil(bytes / 3) * 4 });
    }
  }
  if (occurrences.length === 0) return 0;

  let total = occurrences.reduce((sum, o) => sum + o.base64, 0);
  let count = occurrences.length;
  let omitted = 0;
  for (const occurrence of occurrences) {
    if (count <= maxImages && total <= bytesBudget) break;
    total -= occurrence.base64;
    count -= 1;
    occurrence.message.content[occurrence.index] = {
      type: 'text',
      text: IMAGE_OFFLOAD_PLACEHOLDER,
    };
    omitted += 1;
  }
  return omitted;
}

async function materializeImages(chatMessages, options = {}) {
  const attachments = options.attachments;
  /** 待发的图片：{ mediaType, bytes } */
  const pending = [];
  /** URL -> resolved image | 'failed'. Remote fetches are async. */
  const resolved = new Map();

  const resolveUrl = async (url) => {
    if (resolved.has(url)) return resolved.get(url);
    let value;
    if (/^data:/iu.test(url)) {
      value = parseDataUrl(url) ?? 'failed';
    } else if (/^https?:\/\//iu.test(url) && attachments !== undefined) {
      value = await fetchRemoteImage(url);
      if (value === undefined) value = 'failed';
    } else {
      value = 'failed';
    }
    resolved.set(url, value);
    return value;
  };

  const extract = async (content) => {
    if (!Array.isArray(content)) return content;
    const kept = [];
    for (const part of content) {
      if (part === null || typeof part !== 'object') continue;
      // 'image-url' 是 chatMessagesToDsh 内部为「还没存成附件的内联图」打的标记。
      if (part.type === 'image-url') {
        const value = typeof part.url === 'string' ? await resolveUrl(part.url) : 'failed';
        if (value !== 'failed' && attachments !== undefined) {
          pending.push(value);
          continue;
        }
        kept.push(textBlock(imagePlaceholder(part.url, '图片')));
        continue;
      }
      if (part.type === 'input_image' || part.type === 'image_url') {
        const raw = typeof part.image_url === 'object' && part.image_url !== null
          ? part.image_url.url
          : part.image_url;
        const value = typeof raw === 'string' ? await resolveUrl(raw) : 'failed';
        if (value !== 'failed' && attachments !== undefined) {
          pending.push(value);
          continue;
        }
        // 没有附件服务、或图片无法读取：留占位文本。
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
      message.content = await extract(message.content);
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
  const lengths = [];
  for (const img of pending) {
    try {
      const ref = await attachments.saveImage({
        data: img.bytes,
        mediaType: img.mediaType,
        name: `gateway-image-${Date.now()}`,
      });
      // 记下这张图上传时的字节数：预算按 base64 载荷算，而保存后的 ref.bytes
      // 是规范化（可能被缩过）之后的值，两者不能混用。
      blocks.push({ type: 'image', attachment: ref });
      lengths.push(img.bytes.length);
    } catch (error) {
      // 单张图存不进去不该整轮失败：换成占位文本继续。
      blocks.push({ type: 'text', text: imagePlaceholder(undefined, '图片') });
      lengths.push(0);
      void error;
    }
  }

  out.push({
    id: uuid(),
    role: 'user',
    content: [{ type: 'text', text: TOOL_IMAGE_PLACEHOLDER }, ...blocks],
    source: { kind: 'user' },
  });

  // 省略（而不是拒绝）超出路由图片预算的最老若干张。见 applyImageBudget：
  // 不这么做时，DSH 的适配器会抛 IMAGE_OFFLOAD_REQUIRED，而它的会话级恢复链在
  // 网关这条无状态路径上永远修不好同一个历史。
  const omitted = applyImageBudget(out, {
    maxImages: options.maxRequestImages,
    maxBytes: options.maxRequestImageBytes,
  });
  if (omitted > 0 && typeof options.log === 'function') {
    options.log(
      `image budget: omitted ${omitted} oldest image(s) to fit the route budget; ${blocks.length - omitted} sent`,
    );
  }
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
        result.usage = usageToOpenAI(chunk.usage) ?? {
          prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
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
  /**
   * @param {number} status
   * @param {string} message
   * @param {string} [type]
   * @param {Record<string,string>} [headers] 需要额外附带的响应头，
   *   最常用的是 `x-should-retry: false`（见 NO_RETRY_HEADERS 的说明）。
   */
  constructor(status, message, type = 'invalid_request_error', headers = undefined) {
    super(message);
    this.status = status;
    this.type = type;
    this.headers = headers;
  }
}

/**
 * 明确告诉所有会自动重试的客户端：这次失败**不要重试**。
 *
 * 为什么需要它（照搬 dsh-connect-workbuddy 的做法）：`x-should-retry` 不是标准
 * 头，但这条链上的两个客户端都会在看 HTTP 状态码**之前**先读它 —— 固定版本的
 * OpenAI SDK 的 `shouldRetry` 与 pi-ai 的 `isRetryableProviderError` 都认
 * `"false"`。没有它时，429 会被按状态码无条件重试（宿主一轮 5 次、0.5s→8s 退避，
 * 合计约 15 秒），而排队类失败重试多少次都还是同一个位次，等于白烧请求。
 *
 * 同时把 `retry-after` 置 "0"：声明自己是最终答案的诊断，就必须真的是最终的。
 */
const NO_RETRY_HEADERS = Object.freeze({
  'x-should-retry': 'false',
  'retry-after': '0',
});

/**
 * 请求体超限。用一个具名类而不是「message 里带魔数」：
 * 调用方必须对它回 **413**（协议上的正确答案），当成普通内部错误会变成 500。
 *
 * 必须带 `x-should-retry: false`：超限是**确定性**失败，同一份历史重发还是超限。
 * 没有这个头时 Codex 会按 413 之外的状态码策略重试五轮（界面上显示
 * 「正在重新连接 5/5」），每一轮都把几十 MB 重新传一遍，然后拿到同一句拒绝。
 */
class RequestBodyTooLargeError extends HttpError {
  constructor(limitBytes) {
    super(
      413,
      `request body too large (limit ${limitBytes} bytes); compact the conversation or start a new task`,
      'invalid_request_error',
      NO_RETRY_HEADERS,
    );
    this.name = 'RequestBodyTooLargeError';
    this.limitBytes = limitBytes;
  }
}

async function readJson(request, limitBytes) {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw new RequestBodyTooLargeError(limitBytes);
  }
  const text = await request.text();
  // content-length 不可信（可能缺失或撒谎），按实际读到的字节再卡一次。
  if (Buffer.byteLength(text, 'utf8') > limitBytes) {
    throw new RequestBodyTooLargeError(limitBytes);
  }
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

function json(value, status = 200, headers = undefined) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(headers ?? {}) },
  });
}

function errorResponse(error) {
  if (error instanceof HttpError) {
    return json({ error: { message: error.message, type: error.type } }, error.status, error.headers);
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
        usage = usageToOpenAI(chunk.usage) ?? usage;
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
    const classified = classifiedError(failure);
    sink.write(sseChunk({ error: classified.body }));
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
      message: classifyFailure(failure).hint
        ? `${failure?.message ?? 'upstream failed'} — ${classifyFailure(failure).hint}`
        : failure?.message ?? 'upstream failed',
      code: classifyFailure(failure).code,
      gateway_hint: classifyFailure(failure).hint,
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
    responsesUsageToWire(usage),
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
  // 流式收尾也走同一个转换：缓存与 reasoning 计数照样要报，否则客户端
  // 在流式会话里永远看不到缓存命中率。
  const tokenUsage = responsesUsageToWire({
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: usage?.totalTokens ?? (inputTokens + outputTokens),
    ...(typeof usage?.cacheReadTokens === 'number'
      ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } }
      : {}),
    ...(typeof usage?.reasoningTokens === 'number'
      ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
      : {}),
  });

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
      const body = await readJson(request, config.maxBodyBytes);
      let messages = chatMessagesToDsh(body.messages, { provider: 'gateway', model: body.model });
      messages = await materializeImages(messages, {
        attachments: attachmentsService,
        maxRequestImages: config.maxRequestImages,
        maxRequestImageBytes: config.maxRequestImageBytes,
        log,
      });
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
        const classified = classifiedError(failure);
        throw new HttpError(classified.status, classified.body.message, classified.body.type, classified.headers);
      }
      return json(chatCompletionNonStream(body.model, collected));
    }

    if (request.method === 'POST' && path === '/v1/responses') {
      const body = await readJson(request, config.maxBodyBytes);
      let messages = responsesToDsh(body, { provider: 'gateway', model: body.model });
      messages = await materializeImages(messages, {
        attachments: attachmentsService,
        maxRequestImages: config.maxRequestImages,
        maxRequestImageBytes: config.maxRequestImageBytes,
        log,
      });
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
        const classified = classifiedError(failure);
        throw new HttpError(classified.status, classified.body.message, classified.body.type, classified.headers);
      }
      return json(responsesNonStream(body.model, collected));
    }

    throw new HttpError(404, `no route for ${request.method} ${path}`, 'not_found_error');
  }

  const server = http.createServer(async (request, response) => {
    let result;
    try {
      // node:http IncomingMessage has no .text(); wrap it as a Web Request.
      //
      // 边读边计字节：先把几十 MB 全读进内存再判断超限，等于把「拒绝」变成
      // 「先占满内存再拒绝」。超限后**继续把剩下的字节读掉但丢弃**，而不是
      // 直接 break 或 destroy socket —— 前者会销毁入站流、后者会重置连接，
      // 两种情况下客户端都只看到 broken pipe，读不到 413 和 `x-should-retry:
      // false`，于是照样重试五轮。把请求体排空再回响应，客户端才能读到结论。
      const declared = Number(request.headers['content-length'] ?? 0);
      if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
        log(`413 request body ${formatBytes(declared)} exceeds limit ${formatBytes(config.maxBodyBytes)} (${request.method} ${request.url})`);
        // 还没开始读：先把客户端可能已经发出的字节排掉，再让它读响应。
        await drain(request);
        result = errorResponse(new RequestBodyTooLargeError(config.maxBodyBytes));
      } else {
        const chunks = [];
        let received = 0;
        let overLimit = false;
        for await (const chunk of request) {
          received += chunk.length;
          if (received > config.maxBodyBytes) {
            // 超限：丢掉已读的，后续全部丢弃，但仍然读完。
            if (!overLimit) {
              overLimit = true;
              chunks.length = 0;
            }
            continue;
          }
          if (!overLimit) chunks.push(chunk);
        }
        if (overLimit) {
          log(`413 request body over limit ${formatBytes(config.maxBodyBytes)} (${request.method} ${request.url})`);
          result = errorResponse(new RequestBodyTooLargeError(config.maxBodyBytes));
        } else {
          const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
          const absolute = `http://${request.headers.host ?? `${config.host}:${config.port}`}${request.url ?? '/'}`;
          const webRequest = new Request(absolute, {
            method: request.method,
            headers: request.headers,
            body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
          });
          result = await handle(webRequest);
        }
      }
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
