# DSH LLM gateway

A local, OpenAI-compatible gateway that exposes **every model registered in DSH**
through `ctx.llm` — no upstream protocol is reimplemented here. Codex and other
OpenAI-compatible clients can use the models DSH already knows about.

## Endpoints

- `GET /healthz` — liveness, model count.
- `GET /v1/models` — the model list; ids use the prefixes `deepseek/`, `buddy/`, `free/`.
- `POST /v1/chat/completions` — Chat Completions (streaming and non-streaming).
- `POST /v1/responses` — Responses API (streaming and non-streaming), used by Codex.

By default the server listens on `127.0.0.1:8392`. Configuration lives in the
bundle patch (`host`, `port`, `apiKey`); the gateway does not define a Config schema,
so all values are read from the plugin config with defaults.

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
prefix is explicitly rejected as a provider.

## Tool-call history

Responses `function_call` items are merged into the preceding assistant message
as tool-call blocks (`call_id` is preserved), and `function_call_output` becomes a
`role: tool` message with the matching `toolCallId`. Reasoning items are skipped
because their encrypted payloads are upstream-private. Developer messages are
kept as system prompts. This prevents the upstream 11148 "tool call records do
not match" error.

Chat Completions history is converted the same way: assistant `tool_calls`
become tool-call blocks and `role: tool` messages keep their `call_id`.

## Codex

`build-dsh-catalog.cjs` fetches `/v1/models` and clones the bundled model catalog
schema from `codex debug models --bundled`, then writes the configured
`model_catalog_json` path. Point Codex at:

```toml
model = "buddy/deepseek-v4.1-flash"
model_provider = "dsh"
model_catalog_json = "/Users/zhaochen/.codex/dsh-llm-gateway-models.json"

[model_providers.dsh]
base_url = "http://127.0.0.1:8392/v1"
wire_api = "responses"
```
