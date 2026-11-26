# DSH LLM gateway

A local, OpenAI-compatible gateway that exposes **every model registered in DSH**
through `ctx.llm` — no upstream protocol is reimplemented here. Codex, the ChatGPT
desktop app and other OpenAI-compatible clients can use the models DSH already
knows about.

The gateway holds no credentials and never talks to a model upstream itself:
every request goes through `ctx.llm.stream()`, so credentials, retry policy,
token accounting and provider adapters stay inside DSH.

## Endpoints

- `GET /healthz` — liveness: `{ok, service, models}`; `models` counts visible entries.
- `GET /v1/models` — the model list; ids use the prefixes `deepseek/`, `buddy/`, `free/`.
  Entries also carry `context_length`, `max_output_tokens`,
  `reasoning_supported_efforts` and `reasoning_default_effort`.
- `POST /v1/chat/completions` — Chat Completions (streaming and non-streaming).
- `POST /v1/responses` — Responses API (streaming and non-streaming), used by Codex.

By default the server listens on `127.0.0.1:8392`. Configuration lives in the
bundle patch (`host`, `port`, `apiKey`, `maxBodyBytes`); the gateway does not define
a Config schema, so all values are read from the plugin config with defaults.
Unknown keys are ignored silently. `maxBodyBytes` defaults to 256 MiB: Codex resends
the whole history every turn, and image-heavy conversations get large quickly.

All routes require `Authorization: Bearer <apiKey>` when `apiKey` is non-empty,
including `/healthz`. The gateway sets no CORS headers and has no `OPTIONS`
handler; put a reverse proxy in front if you need cross-origin access.

## Grouped model ids

Codex's model selector shows the public id, so DSH internal provider ids are not
used as prefixes. Providers are grouped as:

| Providers | Prefix | Example id |
| --- | --- | --- |
| `deepseek-official`, `deepseek-account`, `deepseek-flash`, `deepseek-v4.1-flash`, `deepseek-v4.1-flash-free` | `deepseek/` | `deepseek/deepseek-flash` |
| `workbuddy`, `workbuddy-global` | `buddy/` | `buddy/deepseek-v4.1-flash` |
| everything else (the `our-free-model` aggregator lanes) | `free/` | `free/opencode/beam-free` |

If a model id already contains `/`, it is kept intact after the prefix, so
`opencode/beam-free` and `reflection/beam-free` do not collide.

The model catalog is cached for 10 seconds. A request resolves the wire id by
exact public id, then raw model id, then a `<provider>/<model>` split; a group
prefix is explicitly rejected as a provider. Two models sharing one group and the
same model id cannot be addressed — the exact match is ambiguous and the split
form is blocked by the prefix rule.

## Reasoning slots

Codex silently drops reasoning-effort names it does not know and then filters the
visible levels through a whitelist that excludes `none`, `max` and `minimal`. To
keep every upstream level reachable, the gateway never forwards raw level names.
It publishes a fixed five-name ladder —

```text
low → medium → high → xhigh → ultra
```

— with as many slots as the model declares levels, and maps slot *k* back to that
model's *k*-th real level. Models with more than five levels are sampled evenly
so both ends stay covered. `reasoning_supported_efforts` therefore lists slot
names, not upstream level names; sending a real level name (`none`, `max`) is not
mapped and simply selects no effort.

## Tool-call history

Responses `function_call` items are merged into the preceding assistant message
as tool-call blocks (`call_id` is preserved), and `function_call_output` becomes a
`role: tool` message with the matching `toolCallId`. Reasoning items are skipped
because their encrypted payloads are upstream-private. Developer messages are
kept as system prompts. This prevents the upstream 11148 "tool call records do
not match" error.

Chat Completions history is converted the same way: assistant `tool_calls`
become tool-call blocks and `role: tool` messages keep their `call_id`. Before
sending, the gateway repairs the pairing: calls without a result get an
`isError` placeholder, orphan tool results are dropped, and tool results are
moved directly behind the assistant that issued them. Empty text parts are padded
with a single space to avoid upstream 11151 "empty content".

## Images

Inline `data:image/…` and http(s) images are pulled out of the message body,
saved through `ctx.attachments.saveImage()` and re-sent as one extra `user`
message at the end of the turn, because Chat `tool` messages may not carry image
blocks. The message they came from keeps a short placeholder so it does not
become empty. Limits: 8 MB per image, `png` / `jpeg` / `webp` / `gif`, and a
15-second timeout when fetching a remote URL.

Images inside a Responses `message` item are reduced to placeholder text; only
`function_call_output` images are materialised as real attachments.

## Errors

Upstream failures map to a status plus one actionable sentence:

| Upstream signal | Status | Code |
| --- | --- | --- |
| `ACCOUNT_QUOTA`, insufficient balance | 402 | `ACCOUNT_QUOTA` |
| `RATE_LIMIT`, 429, cooling down | 429 | `RATE_LIMIT` |
| `11148`, tool invocation mismatch | 400 | `TOOL_MISMATCH` |
| `11128`, unapproved channel | 400 | `CHANNEL_REJECT` |
| `11135`, invalid image | 400 | `IMAGE_INVALID` |
| `11115`, prompt too long | 400 | `PROMPT_TOO_LONG` |
| `11151`, empty content | 400 | `EMPTY_CONTENT` |
| anything else | 502 | upstream code or `UPSTREAM_ERROR` |

The first six plus `EMPTY_CONTENT` are deterministic, so the response carries
`x-should-retry: false` and `retry-after: 0`; 5xx and transport failures stay
retryable. That header only reaches non-streaming responses — once an SSE stream
has started, headers are already on the wire.

Non-streaming errors are shaped `{error: {message, type}}`; `type` is
`invalid_request_error`, `authentication_error`, `not_found_error`,
`server_error` or `upstream_error`. Streaming errors carry `message`, `type`,
`code` and `gateway_hint` in the event body.

A request body over `maxBodyBytes` (256 MiB by default) returns 413 with
`x-should-retry: false` and `retry-after: 0` — resending the same history is just
as oversized, and without that header Codex retries five times, re-uploading tens
of megabytes each round. The size is counted while reading, and the remaining bytes
are drained before the reply, so the client actually reads the 413 instead of a
broken pipe. Malformed JSON returns 400; a turn that produced reasoning but no text
returns 502 `empty_reasoning_only` so the client retries instead of receiving an
empty success.

Cached token counts are written to both `prompt_tokens_details.cached_tokens` and
`prompt_cache_hit_tokens` (Responses: `input_tokens_details.cached_tokens`), and
reasoning tokens to `completion_tokens_details.reasoning_tokens`
(`output_tokens_details.reasoning_tokens`).

## Unsupported parameters

`n`, `stop`, `top_p`, `seed`, `presence_penalty`, `frequency_penalty`,
`response_format`, `logprobs`, `tool_choice`, `parallel_tool_calls`,
`previous_response_id`, `store`, `include`, `background` and `metadata` are
ignored silently — no error, no effect. Only function tools are forwarded;
`strict`, `web_search`, `file_search` and `custom` tools are dropped. The gateway
is stateless: every turn must resend the full history.

## Codex

`build-dsh-catalog.cjs` fetches `/v1/models`, clones the bundled model catalog
schema from `codex debug models --bundled`, and writes the configured
`model_catalog_json` path. It sends no auth headers, so clear `apiKey` or export
the catalog by hand when auth is on.

```bash
node build-dsh-catalog.cjs --gateway http://127.0.0.1:8392 --out ~/.codex/dsh-llm-gateway-models.json
```

Point Codex at:

```toml
model = "buddy/deepseek-v4.1-flash"
model_provider = "dsh"
model_catalog_json = "/Users/zhaochen/.codex/dsh-llm-gateway-models.json"

[model_providers.dsh]
base_url = "http://127.0.0.1:8392/v1"
wire_api = "responses"
```

Keep those three top-level keys above every `[table]`, and regenerate the catalog
after the upstream model set or effort levels change. The script picks the
highest level it knows as the default and ignores `reasoning_default_effort`.

## Logs

Startup, catalog failures and request failures are appended to
`/tmp/dsh-llm-gateway.log`. Set `DSH_GATEWAY_DEBUG=1` to send full stacks to the
DSH stderr. There is no health heartbeat and no request timeout; a long thinking
turn can leave an SSE connection quiet.

## Tests

`node tests/stream-failure.mjs` runs six regression cases for streaming failure
reporting: an upstream failure must emit `response.failed` / an `error` frame
rather than a `response.completed` or `finish_reason: stop`, including after
partial text; normal answers are unaffected.

`node tests/body-limit.mjs` starts a real gateway and runs four cases for the
request-body limit: an oversized body must return 413 with `x-should-retry: false`
and `retry-after: 0`; a missing `content-length` (chunked upload) is still counted;
`maxBodyBytes` is honoured; and the default accepts tens of megabytes.

Conversion, pairing repair, slots, routing, attachments and the status map are not
covered.
