/**
 * dsh-llm-gateway
 *
 * Exposes every model registered on the DSH `llm` service as a local
 * OpenAI-compatible HTTP endpoint, so external clients (Codex CLI/desktop,
 * ZCode, Claude Code, any OpenAI SDK) can use the same models the DSH UI
 * offers — DeepSeek, WorkBuddy, our-free-model and anything else mounted.
 *
 * Endpoints (all under the configured host/port):
 *   GET  /healthz
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream and non-stream)
 *   POST /v1/responses          (Codex / Responses API, stream and non-stream)
 *
 * Model ids are `<provider>/<model>`; a bare model id is also accepted when it
 * is unambiguous. Nothing here talks to a model upstream directly: every
 * request is dispatched through `ctx.llm.stream()`, so credentials, retry
 * policy, token accounting and provider adapters stay exactly where DSH owns
 * them.
 *
 * Images are admitted through DSH's attachment service, so the same
 * normalization (EXIF, sRGB, size budget) applies as to images uploaded in the
 * DSH UI. Protocol conversion follows the shapes workbuddy2api uses: image_url
 * accepts both string and object form, tool calls and their results are paired
 * into one assistant turn, and orphan results degrade to user text rather than
 * being sent as a tool message the upstream would reject.
 */

import http from 'node:http'

export const name = 'dsh-llm-gateway'

export const inject = ['llm']

const DONE = 'data: [DONE]\n\n'

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

// ---------- Upstream error classification -----------------------------------
// The upstream reports failures through LlmFailure.code / message. Following
// workbuddy2api's taxonomy, request-level failures must be 400 with an
// actionable hint (retrying the same body is pointless), while account- or
// transport-level failures are 502/429 and may succeed on another route.

const REQUEST_LEVEL_CODES = new Set([
  'ACCOUNT_QUOTA', 'RATE_LIMIT', 'TOOL_MISMATCH', 'TOOL_SCHEMA',
  'IMAGE_INVALID', 'PROMPT_TOO_LONG', 'BAD_PARAMS', 'CHANNEL_REJECT',
  'EMPTY_CONTENT', 'MODEL_UNAVAILABLE', 'MODEL_NOT_ALLOWED',
])

function classifyFailure(failure) {
  const code = String(failure?.code ?? '').toUpperCase()
  const message = String(failure?.message ?? '')
  if (code === 'ACCOUNT_QUOTA' || /insufficient balance|credits exhausted|额度不足|余额不足/i.test(message)) {
    return { status: 402, code: 'ACCOUNT_QUOTA', hint: 'Upstream account has no balance; top up or pick another provider group.' }
  }
  if (code === 'RATE_LIMIT' || /rate limit|quota|429|too many requests|冷却|限流/i.test(message)) {
    return { status: 429, code: 'RATE_LIMIT', hint: 'Upstream is rate limited; retry later or use a different group.' }
  }
  if (/11148|tool invocation|tool_call.*match|工具调用记录/i.test(message)) {
    return { status: 400, code: 'TOOL_MISMATCH', hint: 'Tool-call history is inconsistent; start a new task or remove orphan tool results.' }
  }
  if (/11128|unapproved channel|渠道校验|request illegal/i.test(message)) {
    return { status: 400, code: 'CHANNEL_REJECT', hint: 'Upstream rejected the prompt shape; try a shorter system prompt or a different model.' }
  }
  if (/11135|invalid image|image.*invalid|图片/i.test(message)) {
    return { status: 400, code: 'IMAGE_INVALID', hint: 'The image could not be read by the upstream; try a small PNG/JPEG data URL.' }
  }
  if (/11115|too long|context.*exceed|超长|上下文/i.test(message)) {
    return { status: 400, code: 'PROMPT_TOO_LONG', hint: 'Input exceeds the model context; shorten the conversation or use a bigger-window model.' }
  }
  if (REQUEST_LEVEL_CODES.has(code)) {
    return { status: 400, code, hint: 'Upstream rejected this request; retrying the same body will not help.' }
  }
  return { status: 502, code: failure?.code ?? 'UPSTREAM_ERROR', hint: undefined }
}

function openaiError(res, status, message, code, type = 'invalid_request_error', hint) {
  const error = { message: hint ? `${message} — ${hint}` : message, type, code: code ?? type }
  if (hint) error.gateway_hint = hint
  json(res, status, { error })
}

function upstreamFailureError(res, failure) {
  const classified = classifyFailure(failure)
  return openaiError(
    res,
    classified.status,
    failure?.message ?? 'upstream failed',
    classified.code,
    classified.status >= 500 ? 'server_error' : 'upstream_error',
    classified.hint,
  )
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    const limit = 64 * 1024 * 1024
    req.on('data', (c) => {
      bytes += c.length
      if (bytes > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

let seq = 0
function nextId(prefix) {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`
}

/** Flatten one OpenAI content value into text (string | array of parts). */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (part && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n')
}

// ---------- Image admission -------------------------------------------------
// Mirrors workbuddy2api's approach: accept every image shape the OpenAI wire
// uses (image_url string OR object, input_image data URL), then hand the bytes
// to DSH's attachment service so normalization and limits are shared with the
// rest of the app. A data URL is decoded locally; a remote https URL is
// fetched with a bounded timeout and size cap. Anything that fails is turned
// into visible placeholder text in the message, so the model knows an image
// was present but could not be delivered — the request itself still succeeds.

const IMAGE_MAX_BYTES = 8 * 1024 * 1024 // per image, before DSH normalization
const IMAGE_FETCH_TIMEOUT_MS = 15_000
const MEDIA_TYPE_BY_MIME = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

function mediaTypeOf(mime) {
  return MEDIA_TYPE_BY_MIME[String(mime ?? '').toLowerCase().split(';')[0]] ?? undefined
}

/** Extract the URL from an OpenAI image_url part (string or object form). */
function imageUrlOf(part) {
  if (!part || part.type !== 'image_url') return undefined
  const value = part.image_url
  if (typeof value === 'string') return value.trim() || undefined
  if (value && typeof value.url === 'string') return value.url.trim() || undefined
  if (typeof part.url === 'string') return part.url.trim() || undefined
  return undefined
}

/** Extract the URL from a Responses input_image part. */
function inputImageUrlOf(item) {
  if (!item || item.type !== 'input_image') return undefined
  const value = item.image_url
  if (typeof value === 'string') return value.trim() || undefined
  if (value && typeof value.url === 'string') return value.url.trim() || undefined
  if (typeof item.url === 'string') return item.url.trim() || undefined
  return undefined
}

/** Decode a data URL to { data(base64), mediaType } with a byte cap. */
function decodeDataUrl(url) {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(url)
  if (!match) return undefined
  const mediaType = mediaTypeOf(match[1])
  if (!mediaType) return undefined
  const data = match[2].replace(/\s+/g, '')
  let bytes
  try {
    bytes = Buffer.from(data, 'base64')
  } catch {
    return undefined
  }
  if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) return undefined
  return { data: bytes.toString('base64'), mediaType, bytes: bytes.length }
}

/** Fetch a remote image with a timeout and hard size cap. */
async function fetchImageAsDataUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) return undefined
    const contentType = res.headers.get('content-type') ?? ''
    const mediaType = mediaTypeOf(contentType)
    if (!mediaType) return undefined
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > IMAGE_MAX_BYTES) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > IMAGE_MAX_BYTES) return undefined
    return { data: buf.toString('base64'), mediaType, bytes: buf.length }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Admit one image source into DSH's attachment store.
 * Returns an ImageBlock-ready reference, or undefined on any failure.
 * DSH does its own normalization and applies its own limits on top of ours.
 */
async function admitImageSource(ctx, url) {
  if (typeof url !== 'string' || url === '') return undefined
  let decoded
  if (url.startsWith('data:')) {
    decoded = decodeDataUrl(url)
  } else if (/^https?:\/\//i.test(url)) {
    decoded = await fetchImageAsDataUrl(url)
  } else {
    // Bare base64 is accepted too, like workbuddy2api's data-URL fallback.
    try {
      const bytes = Buffer.from(url, 'base64')
      if (bytes.length > 0 && bytes.length <= IMAGE_MAX_BYTES) {
        decoded = { data: url, mediaType: 'image/png', bytes: bytes.length }
      }
    } catch {
      /* ignore */
    }
  }
  if (!decoded) return undefined
  const store = ctx.get?.('attachments')
  if (!store || typeof store.admitPromptContent !== 'function') return undefined
  try {
    const admitted = await store.admitPromptContent([{
      type: 'image',
      mediaType: decoded.mediaType,
      data: decoded.data,
    }])
    const image = admitted?.[0]
    if (image?.type === 'image' && image.attachment) return { type: 'image', attachment: image.attachment }
  } catch (error) {
    ctx.logger?.warn?.('dsh-llm-gateway: image admission failed', error?.message ?? error)
  }
  return undefined
}

/** Convert admitted content parts into text + image blocks for a user message. */
async function contentToRequestParts(ctx, content) {
  const text = contentToText(content)
  const parts = []
  if (text) parts.push({ type: 'text', text })
  const urls = []
  if (typeof content === 'string') {
    // No inline image in a plain string.
  } else if (Array.isArray(content)) {
    for (const part of content) {
      const url = imageUrlOf(part)
        ?? (part?.type === 'input_image' ? inputImageUrlOf(part) : undefined)
        ?? (typeof part?.image_url === 'string' ? part.image_url : undefined)
      if (url) urls.push(url)
    }
  }
  let admitted = 0
  for (const url of urls) {
    const block = await admitImageSource(ctx, url)
    if (block) {
      parts.push(block)
      admitted += 1
    } else {
      parts.push({ type: 'text', text: `[image unavailable: ${url.slice(0, 120)}]` })
    }
  }
  if (parts.length === 0) parts.push({ type: 'text', text: '' })
  return { parts, admitted, attempted: urls.length }
}

/** Convert OpenAI chat messages into DSH RequestMessage[] plus a system prompt. */
async function toRequestMessages(ctx, messages, provider, model) {
  const out = []
  const systemParts = []
  let imagesAdmitted = 0
  let imagesAttempted = 0

  // workbuddy2api pairs every tool result with the assistant tool-call that
  // declared it before sending upstream. Collect declared ids first so a
  // result with no matching call can be degraded to user text instead of
  // becoming an orphan tool message (upstream returns 11148 for those).
  const declared = new Set()
  for (const msg of messages ?? []) {
    if (msg?.role !== 'assistant') continue
    for (const call of msg.tool_calls ?? []) {
      if (call?.id) declared.add(call.id)
    }
  }
  // Adjacent assistant.tool_calls batches are merged into ONE assistant
  // message; splitting them makes some upstreams stop after the first line.
  let pendingTools = null
  const flushTools = () => {
    if (pendingTools === null) return
    if (pendingTools.blocks.length === 0) pendingTools.blocks.push({ type: 'text', text: '' })
    out.push({
      role: 'assistant',
      content: pendingTools.blocks,
      source: { kind: 'model', provider, model },
    })
    pendingTools = null
  }

  for (const msg of messages ?? []) {
    const role = msg?.role
    if (role === 'system' || role === 'developer') {
      flushTools()
      const text = contentToText(msg.content)
      if (text) systemParts.push(text)
      continue
    }
    if (role === 'user') {
      flushTools()
      const { parts, admitted, attempted } = await contentToRequestParts(ctx, msg.content)
      imagesAdmitted += admitted
      imagesAttempted += attempted
      out.push({ role: 'user', content: parts, source: { kind: 'user' } })
      continue
    }
    if (role === 'assistant') {
      const blocks = []
      const text = contentToText(msg.content)
      if (text) blocks.push({ type: 'text', text })
      for (const call of msg.tool_calls ?? []) {
        if (!call?.function?.name) continue
        blocks.push({
          type: 'tool-call',
          id: call.id ?? nextId('call'),
          name: call.function.name,
          arguments: call.function.arguments ?? '{}',
        })
      }
      if (pendingTools === null) pendingTools = { blocks: [] }
      pendingTools.blocks.push(...blocks)
      continue
    }
    if (role === 'tool') {
      const callId = msg.tool_call_id ?? nextId('call')
      // A tool result whose call was never declared is sent as user text: the
      // upstream would reject it as a mismatched tool invocation (11148).
      if (!declared.has(callId)) {
        flushTools()
        const text = contentToText(msg.content)
        out.push({
          role: 'user',
          content: [{ type: 'text', text: `[tool result ${callId}] ${text}` }],
          source: { kind: 'user' },
        })
        continue
      }
      flushTools()
      out.push({
        role: 'tool',
        content: [{ type: 'text', text: contentToText(msg.content) }],
        source: { kind: 'tool', callId },
        toolCallId: callId,
      })
    }
  }
  flushTools()
  return {
    messages: out,
    system: systemParts.join('\n\n') || undefined,
    images: { admitted: imagesAdmitted, attempted: imagesAttempted },
  }
}

/** Convert OpenAI tool declarations into DSH ToolSchema[]. */
function toToolSchemas(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out = []
  for (const tool of tools) {
    if (!tool) continue
    const fn = tool.function ?? tool
    const toolName = fn.name
    if (!toolName) continue
    out.push({
      name: toolName,
      description: fn.description ?? '',
      parameters: fn.parameters ?? { type: 'object', properties: {} },
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Convert a Responses-API `input` array into DSH request messages.
 *
 * The Responses wire splits one assistant turn across several items:
 *
 *   {type:'message', role:'assistant', content:[…]}
 *   {type:'function_call', call_id, name, arguments}
 *   {type:'function_call_output', call_id, output}
 *
 * Upstream gateways reject a conversation whose tool results have no matching
 * assistant tool-call (WorkBuddy answers 11148 "tool invocation record
 * mismatch"), so a call and the message text around it must be reassembled into
 * ONE assistant message carrying both text and tool-call blocks. Outputs then
 * become tool messages, in the order the calls were declared.
 */
async function responsesInputToMessages(ctx, input, instructions, provider, model) {
  const systemParts = []
  if (typeof instructions === 'string' && instructions.trim()) systemParts.push(instructions)
  const items = Array.isArray(input) ? input : typeof input === 'string' ? [{ role: 'user', content: input }] : []

  const out = []
  let imagesAdmitted = 0
  let imagesAttempted = 0

  // Collect all declared call ids first, so a function_call_output with no
  // matching call can be degraded to user text (workbuddy2api does the same;
  // an orphan tool result reaches the upstream as 11148).
  const declared = new Set()
  for (const item of items) {
    if (item?.type === 'function_call' && (item.call_id ?? item.id)) {
      declared.add(item.call_id ?? item.id)
    }
  }

  // One function_call_output may carry images in its output array (Codex's
  // view_image tool). Chat tool messages cannot carry images, so they are held
  // and emitted as a user message after the whole tool batch, as
  // workbuddy2api's splitToolImages() does.
  let toolImages = []

  // The assistant turn currently being accumulated. Consecutive assistant-side
  // items (text then one or more function calls) belong to the same message.
  let pending = null

  const flushToolImages = async () => {
    if (toolImages.length === 0) return
    const parts = []
    for (const url of toolImages) {
      const block = await admitImageSource(ctx, url)
      if (block) {
        parts.push(block)
        imagesAdmitted += 1
      }
    }
    imagesAttempted += toolImages.length
    if (parts.length > 0) {
      out.push({
        role: 'user',
        content: [{ type: 'text', text: '[images from tool result]' }, ...parts],
        source: { kind: 'user' },
      })
    }
    toolImages = []
  }

  const flush = () => {
    if (pending === null) return
    if (pending.blocks.length === 0) pending.blocks.push({ type: 'text', text: '' })
    // Reasoning is a native content block upstream understands; putting it in
    // the same assistant turn preserves the model's thinking across tool calls
    // (workbuddy2api keeps it on the assistant rather than dropping it).
    const blocks = pending.reasoning
      ? [{ type: 'reasoning', text: pending.reasoning }, ...pending.blocks]
      : pending.blocks
    out.push({
      role: 'assistant',
      content: blocks,
      source: { kind: 'model', provider, model },
    })
    pending = null
  }

  for (const item of items) {
    if (!item) continue
    const type = item.type

    if (type === 'function_call' || type === 'custom_tool_call') {
      // Opens (or joins) the assistant turn that owns this call. A batch of
      // calls must stay in ONE assistant message, never one message per call.
      if (pending === null) pending = { blocks: [] }
      pending.blocks.push({
        type: 'tool-call',
        id: item.call_id ?? item.id ?? nextId('call'),
        name: item.name ?? 'tool',
        arguments: typeof item.arguments === 'string'
          ? item.arguments
          : typeof item.input === 'string'
            ? item.input
            : JSON.stringify(item.arguments ?? item.input ?? {}),
      })
      continue
    }

    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      flush()
      const callId = item.call_id ?? item.id ?? nextId('call')
      const rawOutput = item.output
      const text =
        typeof rawOutput === 'string'
          ? rawOutput
          : typeof rawOutput?.content === 'string'
            ? rawOutput.content
            : JSON.stringify(rawOutput ?? '')
      // Images inside a tool result (Codex view_image) are split out: chat
      // tool messages cannot carry images, so emit them after as user content.
      if (Array.isArray(rawOutput)) {
        for (const part of rawOutput) {
          const url = inputImageUrlOf(part) ?? imageUrlOf(part)
          if (url) toolImages.push(url)
        }
      }
      if (!declared.has(callId)) {
        // Orphan result: an empty tool_call_id upstream returns 11148. Send
        // it as visible user text so the conversation still makes sense.
        out.push({
          role: 'user',
          content: [{ type: 'text', text: `[tool result ${callId}] ${text}` }],
          source: { kind: 'user' },
        })
      } else {
        out.push({
          role: 'tool',
          content: [{ type: 'text', text }],
          source: { kind: 'tool', callId },
          toolCallId: callId,
        })
      }
      continue
    }

    if (type === 'reasoning') {
      // Reasoning items carry no content the upstream needs back; their
      // encrypted payload is provider-private. Keep the summary text so the
      // same turn's assistant message can carry reasoning_content.
      const summary = Array.isArray(item.summary)
        ? item.summary.map((s) => (typeof s?.text === 'string' ? s.text : '')).join('')
        : ''
      if (summary) {
        if (pending === null) pending = { blocks: [] }
        pending.reasoning = (pending.reasoning ?? '') + summary
      }
      continue
    }

    if (type === 'input_image') {
      const url = inputImageUrlOf(item)
      if (url) toolImages.push(url)
      continue
    }

    // A plain message item ends any open assistant turn.
    const role = item.role ?? (type === 'message' ? 'user' : undefined)
    if (role === undefined) continue
    const text = contentToText(item.content)
    if (role === 'system' || role === 'developer') {
      flush()
      await flushToolImages()
      if (text) systemParts.push(text)
      continue
    }
    if (role === 'assistant') {
      if (pending === null) pending = { blocks: [] }
      if (text) pending.blocks.push({ type: 'text', text })
      continue
    }
    flush()
    await flushToolImages()
    if (role === 'user') {
      const { parts, admitted, attempted } = await contentToRequestParts(ctx, item.content)
      imagesAdmitted += admitted
      imagesAttempted += attempted
      out.push({ role: 'user', content: parts, source: { kind: 'user' } })
    }
  }
  flush()
  await flushToolImages()

  return {
    messages: out,
    system: systemParts.join('\n\n') || undefined,
    images: { admitted: imagesAdmitted, attempted: imagesAttempted },
  }
}

/** Responses-API tools (`{type:'function', name, ...}`). */
function responsesTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out = []
  for (const tool of tools) {
    if (!tool || tool.type !== 'function') continue
    out.push({
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    })
  }
  return out.length > 0 ? out : undefined
}

function finishToOpenAI(reason) {
  switch (reason?.kind) {
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    case 'aborted':
    case 'error': return 'stop'
    default: return 'stop'
  }
}

function finishToResponses(reason) {
  switch (reason?.kind) {
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'incomplete'
    default: return 'completed'
  }
}

/**
 * Mount the gateway.
 * @param ctx - Cordis context with the llm service injected.
 * @param config - resolved plugin row config.
 */
export function apply(ctx, config) {
  const host = config.host ?? '127.0.0.1'
  const port = Number(config.port ?? 8392)
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey : ''

  let server
  let modelsCache = { at: 0, value: [] }

  /**
   * Which public prefix a provider's models are advertised under.
   *
   * codex's picker groups by name, so the raw provider ids ("deepseek-account",
   * "workbuddy", "our-free-model", plus ~50 aggregate lanes) are noise. Three
   * groups make the three upstream families obvious at a glance:
   *
   *   deepseek/…  DeepSeek's own routes
   *   buddy/…     WorkBuddy (the tencent gateway)
   *   free/…      the free lanes, including every aggregate provider
   *
   * Anything not explicitly mapped falls into `free`, because every remaining
   * provider was added by our-free-model's aggregate registry.
   */
  const PREFIX_BY_PROVIDER = new Map([
    ['deepseek-official', 'deepseek'],
    ['deepseek-account', 'deepseek'],
    ['deepseek-flash', 'deepseek'],
    ['deepseek-v4.1-flash', 'deepseek'],
    ['deepseek-v4.1-flash-free', 'deepseek'],
    ['workbuddy', 'buddy'],
    ['workbuddy-global', 'buddy'],
  ])

  function prefixOf(providerId) {
    return PREFIX_BY_PROVIDER.get(providerId) ?? 'free'
  }

  /**
   * Public model id for one catalogue row.
   *
   * Aggregate lanes register their entries already namespaced ("openrouter/x"),
   * so the bare model id is kept after the public prefix instead of stacking a
   * second slash. The one collision this can create — "opencode/beam-free" and
   * "reflection/beam-free" both becoming "free/opencode/beam-free" — is why the
   * upstream lane is preserved in that case.
   */
  function publicIdOf(entry) {
    const prefix = prefixOf(entry.provider)
    if (entry.model.includes('/')) {
      // Already lane-qualified upstream; collapse "opencode/x" to "free/opencode/x"
      // only when the lane is unambiguous, else keep the full path.
      return entry.model.startsWith(`${prefix}/`) ? entry.model : `${prefix}/${entry.model}`
    }
    return `${prefix}/${entry.model}`
  }

  /** Enumerate every provider/model the llm service knows about. */
  async function listAllModels() {
    const now = Date.now()
    if (now - modelsCache.at < 10_000 && modelsCache.value.length > 0) return modelsCache.value
    const out = []
    let providers = []
    try {
      providers = ctx.llm.listProviders() ?? []
    } catch {
      providers = []
    }
    for (const provider of providers) {
      const providerId = typeof provider === 'string' ? provider : provider?.id
      if (!providerId) continue
      let models = []
      try {
        models = (await ctx.llm.listModels(providerId)) ?? []
      } catch {
        models = []
      }
      for (const model of models) {
        const modelId = model?.id
        if (!modelId) continue
        out.push({
          provider: providerId,
          model: modelId,
          name: model.name ?? modelId,
          description: model.description,
          contextWindow: model.context?.contextWindow ?? model.contextWindow,
          inputModalities: model.inputModalities,
        })
      }
    }
    modelsCache = { at: now, value: out }
    return out
  }

  /** Resolve a wire model id to an exact provider/model route. */
  async function resolveRoute(wireId) {
    const all = await listAllModels()
    if (typeof wireId !== 'string' || wireId === '') {
      return { error: 'model is required' }
    }

    // 1. Public id ("buddy/deepseek-v4.1-flash", "free/opencode/beam-free").
    const byPublic = all.filter((m) => publicIdOf(m) === wireId)
    if (byPublic.length === 1) return { provider: byPublic[0].provider, model: byPublic[0].model }
    if (byPublic.length > 1) {
      const providers = [...new Set(byPublic.map((m) => m.provider))].join(', ')
      return { error: `model "${wireId}" is ambiguous across providers: ${providers}` }
    }

    // 2. A raw upstream model id, including ids that already carry a lane prefix
    //    such as "openrouter/…". Accepted so a caller can bypass the grouping.
    const exact = all.filter((m) => m.model === wireId)
    if (exact.length === 1) return { provider: exact[0].provider, model: exact[0].model }
    if (exact.length > 1) {
      const providers = [...new Set(exact.map((m) => m.provider))].join(', ')
      return { error: `model "${wireId}" is ambiguous; prefix it with one of: ${providers}` }
    }

    // 3. A raw "<provider>/<model>" pair, for a provider the catalogue could not
    //    enumerate (temporarily unreachable) but the caller knows explicitly.
    const slash = wireId.indexOf('/')
    if (slash > 0) {
      const provider = wireId.slice(0, slash)
      const model = wireId.slice(slash + 1)
      if (PREFIX_BY_PROVIDER.has(provider)) {
        return {
          error: `"${provider}" is a grouping prefix, not a provider; use a full model id such as "${publicIdOf({ provider, model })}"`,
        }
      }
      return { provider, model }
    }

    const groups = [...new Set(all.map((m) => prefixOf(m.provider)))].join(', ')
    return { error: `unknown model "${wireId}"; use "<group>/<model>" where group is one of: ${groups}` }
  }

  function authorized(req) {
    if (!apiKey) return true
    const header = req.headers.authorization ?? ''
    const bearer = /^Bearer\s+(.+)$/i.exec(header.trim())
    const presented = bearer ? bearer[1] : header
    return presented === apiKey
  }

  async function handleModels(res) {
    const all = await listAllModels()
    const seen = new Set()
    const data = []
    for (const entry of all) {
      const id = publicIdOf(entry)
      if (seen.has(id)) continue
      seen.add(id)
      const model = {
        id,
        object: 'model',
        created: 0,
        owned_by: prefixOf(entry.provider),
      }
      // Advertise image capability when DSH's own adapter declares it, so
      // clients that gate attachments on the catalog can send them.
      if (Array.isArray(entry.inputModalities) && entry.inputModalities.includes('image')) {
        model.input_modalities = ['text', 'image']
      }
      data.push(model)
    }
    json(res, 200, { object: 'list', data })
  }

  /** Shared streaming driver: iterate llm chunks and hand each to the sink. */
  async function drive(options, signal, sink) {
    let finished = false
    for await (const chunk of ctx.llm.stream({ ...options, signal })) {
      if (chunk.type === 'finish') {
        finished = true
        await sink.finish(chunk)
        continue
      }
      await sink.chunk(chunk)
    }
    if (!finished) await sink.finish({ type: 'finish', reason: { kind: 'stop' } })
  }

  async function handleChat(req, res) {
    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      return openaiError(res, 400, 'invalid JSON body')
    }
    const route = await resolveRoute(body.model)
    if (route.error) return openaiError(res, 400, route.error, 'model_not_found')

    const { messages, system, images } = await toRequestMessages(ctx, body.messages, route.provider, route.model)
    if (messages.length === 0) return openaiError(res, 400, 'messages must not be empty')
    if (images.attempted > 0) {
      ctx.logger?.info?.(`dsh-llm-gateway: admitted ${images.admitted}/${images.attempted} images for chat request`)
    }

    const controller = new AbortController()
    res.on('close', () => controller.abort())

    const options = {
      provider: route.provider,
      model: route.model,
      messages,
      system,
      tools: toToolSchemas(body.tools),
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    }

    const id = nextId('chatcmpl')
    const created = Math.floor(Date.now() / 1000)
    const wantStream = body.stream === true

    if (!wantStream) {
      let text = ''
      let reasoning = ''
      const toolCalls = []
      let finishReason = 'stop'
      let usage
      let failure
      await drive(options, controller.signal, {
        async chunk(chunk) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
          else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
            toolCalls.push(chunk.block)
          } else if (chunk.type === 'usage') usage = chunk.usage
        },
        async finish(chunk) {
          finishReason = finishToOpenAI(chunk.reason)
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            failure = chunk.reason.failure
          }
        },
      })
      if (failure) {
        return upstreamFailureError(res, failure)
      }
      const message = { role: 'assistant', content: text }
      if (reasoning) message.reasoning_content = reasoning
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
        message.content = text || null
      }
      const payload = {
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
      }
      if (usage) {
        payload.usage = {
          prompt_tokens: usage.inputTokens ?? 0,
          completion_tokens: usage.outputTokens ?? 0,
          total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        }
      }
      return json(res, 200, payload)
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    const base = { id, object: 'chat.completion.chunk', created, model: body.model }
    let roleSent = false
    let usage
    const toolIndex = new Map()
    let nextToolIndex = 0

    await drive(options, controller.signal, {
      async chunk(chunk) {
        if (!roleSent) {
          send({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
          roleSent = true
        }
        if (chunk.type === 'text-delta') {
          send({ ...base, choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] })
        } else if (chunk.type === 'reasoning-delta') {
          send({ ...base, choices: [{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }] })
        } else if (chunk.type === 'tool-call-delta') {
          let index = toolIndex.get(chunk.id)
          if (index === undefined) {
            index = nextToolIndex++
            toolIndex.set(chunk.id, index)
            send({
              ...base,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{ index, id: chunk.id, type: 'function', function: { name: chunk.name ?? '', arguments: '' } }],
                },
                finish_reason: null,
              }],
            })
          }
          if (chunk.argumentsDelta) {
            send({
              ...base,
              choices: [{
                index: 0,
                delta: { tool_calls: [{ index, function: { arguments: chunk.argumentsDelta } }] },
                finish_reason: null,
              }],
            })
          }
        } else if (chunk.type === 'usage') {
          usage = chunk.usage
        }
      },
      async finish(chunk) {
        if (!roleSent) {
          send({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
          roleSent = true
        }
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
          const failure = chunk.reason.failure
          const classified = classifyFailure(failure)
          send({
            error: {
              message: classified.hint
                ? `${failure?.message ?? 'upstream failed'} — ${classified.hint}`
                : failure?.message ?? 'upstream failed',
              type: 'upstream_error',
              code: classified.code,
              gateway_hint: classified.hint,
            },
          })
          res.write(DONE)
          res.end()
          return
        }
        const payload = { ...base, choices: [{ index: 0, delta: {}, finish_reason: finishToOpenAI(chunk.reason) }] }
        if (usage) {
          payload.usage = {
            prompt_tokens: usage.inputTokens ?? 0,
            completion_tokens: usage.outputTokens ?? 0,
            total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          }
        }
        send(payload)
        res.write(DONE)
        res.end()
      },
    })
  }

  async function handleResponses(req, res) {
    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      return openaiError(res, 400, 'invalid JSON body')
    }
    const route = await resolveRoute(body.model)
    if (route.error) return openaiError(res, 400, route.error, 'model_not_found')

    const { messages, system, images } = await responsesInputToMessages(
      ctx,
      body.input,
      body.instructions,
      route.provider,
      route.model,
    )
    if (messages.length === 0) return openaiError(res, 400, 'input must not be empty')
    if (images.attempted > 0) {
      ctx.logger?.info?.(`dsh-llm-gateway: admitted ${images.admitted}/${images.attempted} images for responses request`)
    }

    const controller = new AbortController()
    res.on('close', () => controller.abort())

    const options = {
      provider: route.provider,
      model: route.model,
      messages,
      system,
      tools: responsesTools(body.tools),
      temperature: body.temperature,
      maxTokens: body.max_output_tokens,
    }

    const responseId = nextId('resp')
    const createdAt = Math.floor(Date.now() / 1000)
    const messageId = nextId('msg')
    const wantStream = body.stream === true

    const outputItem = (text, toolCalls) => {
      const items = []
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          items.push({
            id: nextId('fc'),
            type: 'function_call',
            status: 'completed',
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
          })
        }
      }
      if (text || items.length === 0) {
        items.push({
          id: messageId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        })
      }
      return items
    }

    if (!wantStream) {
      let text = ''
      let reasoning = ''
      const toolCalls = []
      let usage
      let failure
      let reason = { kind: 'stop' }
      await drive(options, controller.signal, {
        async chunk(chunk) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
          else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') toolCalls.push(chunk.block)
          else if (chunk.type === 'usage') usage = chunk.usage
        },
        async finish(chunk) {
          reason = chunk.reason
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk.reason.failure
        },
      })
      if (failure) {
        return upstreamFailureError(res, failure)
      }
      const output = []
      if (reasoning) {
        output.push({
          id: nextId('rs'),
          type: 'reasoning',
          status: 'completed',
          summary: [{ type: 'summary_text', text: reasoning }],
        })
      }
      output.push(...outputItem(text, toolCalls))
      const payload = {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        model: body.model,
        status: finishToResponses(reason),
        output,
      }
      if (usage) {
        payload.usage = {
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
          total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        }
      }
      return json(res, 200, payload)
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const send = (event, obj) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    }
    const shell = { id: responseId, object: 'response', created_at: createdAt, model: body.model }
    send('response.created', { type: 'response.created', response: { ...shell, status: 'in_progress', output: [] } })

    let text = ''
    let reasoning = ''
    const toolCalls = []
    let usage
    let outputIndex = 0
    let reasoningItemOpen = false
    let textItemOpen = false

    await drive(options, controller.signal, {
      async chunk(chunk) {
        if (chunk.type === 'reasoning-delta') {
          if (!reasoningItemOpen) {
            reasoningItemOpen = true
            send('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: outputIndex,
              item: { id: nextId('rs'), type: 'reasoning', status: 'in_progress', summary: [] },
            })
          }
          reasoning += chunk.text
          send('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', output_index: outputIndex, delta: chunk.text })
          return
        }
        if (chunk.type === 'text-delta') {
          if (!textItemOpen) {
            textItemOpen = true
            send('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: outputIndex,
              item: { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
            })
            send('response.content_part.added', {
              type: 'response.content_part.added',
              item_id: messageId,
              output_index: outputIndex,
              content_index: 0,
              part: { type: 'output_text', text: '' },
            })
          }
          text += chunk.text
          send('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: messageId,
            output_index: outputIndex,
            content_index: 0,
            delta: chunk.text,
          })
          return
        }
        if (chunk.type === 'tool-call-delta') {
          const existing = toolCalls.find((c) => c.id === chunk.id)
          if (existing) existing.arguments += chunk.argumentsDelta ?? ''
          else {
            toolCalls.push({ id: chunk.id, name: chunk.name ?? 'tool', arguments: chunk.argumentsDelta ?? '' })
          }
          return
        }
        if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          const existing = toolCalls.find((c) => c.id === chunk.block.id)
          if (existing) {
            existing.name = chunk.block.name
            existing.arguments = chunk.block.arguments
          } else {
            toolCalls.push({ id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
          }
          return
        }
        if (chunk.type === 'usage') usage = chunk.usage
      },
      async finish(chunk) {
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
          const failure = chunk.reason.failure
          const classified = classifyFailure(failure)
          send('response.failed', {
            type: 'response.failed',
            response: {
              ...shell,
              status: 'failed',
              error: {
                message: classified.hint
                  ? `${failure?.message ?? 'upstream failed'} — ${classified.hint}`
                  : failure?.message ?? 'upstream failed',
                code: classified.code,
                gateway_hint: classified.hint,
              },
            },
          })
          res.end()
          return
        }
        const finalOutput = []
        if (reasoningItemOpen) {
          finalOutput.push({
            id: nextId('rs'),
            type: 'reasoning',
            status: 'completed',
            summary: [{ type: 'summary_text', text: reasoning }],
          })
          send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: finalOutput[0] })
          outputIndex += 1
        }
        if (textItemOpen) {
          const item = {
            id: messageId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          }
          send('response.output_text.done', { type: 'response.output_text.done', item_id: messageId, output_index: outputIndex, content_index: 0, text })
          send('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item })
          finalOutput.push(item)
        }
        for (const call of toolCalls) {
          const item = {
            id: nextId('fc'),
            type: 'function_call',
            status: 'completed',
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
          }
          send('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item })
          finalOutput.push(item)
          outputIndex += 1
        }
        const response = {
          ...shell,
          status: finishToResponses(chunk.reason),
          output: finalOutput,
        }
        if (usage) {
          response.usage = {
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
            total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          }
        }
        send('response.completed', { type: 'response.completed', response })
        res.end()
      },
    })
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`)
      if (req.method === 'GET' && url.pathname === '/healthz') {
        const models = await listAllModels()
        return json(res, 200, { ok: true, service: 'dsh-llm-gateway', models: models.length })
      }
      if (!authorized(req)) {
        return openaiError(res, 401, 'missing or invalid API key', 'unauthorized', 'authentication_error')
      }
      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/v1/models/')) {
        return handleModels(res)
      }
      if (req.method === 'POST' && /^\/v1\/chat\/completions\/?$/.test(url.pathname)) {
        return handleChat(req, res)
      }
      if (req.method === 'POST' && /^\/v1\/responses\/?$/.test(url.pathname)) {
        return handleResponses(req, res)
      }
      return openaiError(res, 404, `no such route: ${req.method} ${url.pathname}`, 'not_found')
    } catch (error) {
      ctx.logger?.warn?.('dsh-llm-gateway: request failed', error)
      if (!res.headersSent) {
        return openaiError(res, 500, error?.message ?? 'internal error', 'internal_error', 'server_error')
      }
      try {
        res.end()
      } catch {
        /* already closed */
      }
    }
  }

  ctx.effect(() => {
    server = http.createServer(handler)
    server.on('clientError', (_err, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch {
        /* ignore */
      }
    })
    server.listen(port, host, () => {
      ctx.logger?.info?.(`dsh-llm-gateway listening on http://${host}:${port} (OpenAI + Responses)`)
    })
    server.on('error', (error) => {
      ctx.logger?.error?.(`dsh-llm-gateway: listener failed on ${host}:${port}`, error)
    })
    return async () => {
      await new Promise((resolve) => {
        try {
          server.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
  })
}
