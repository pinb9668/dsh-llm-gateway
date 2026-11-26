# dsh-llm-gateway

A DeepSeek Harness (DSH) Host plugin that exposes every model registered on DSH's `llm` service through a local OpenAI-compatible HTTP endpoint. External coding agents (Codex CLI / desktop, ZCode, Claude Code, any OpenAI SDK) can therefore use the same models the DSH UI offers.

## What it does

- Reads every provider/model from `ctx.llm` — DeepSeek, WorkBuddy, our-free-model and all its aggregate lanes — and advertises them at `GET /v1/models`.
- Groups them under three readable prefixes:
  - `deepseek/` — DeepSeek official routes
  - `buddy/` — WorkBuddy (Tencent gateway)
  - `free/` — our-free-model and its aggregate channels (e.g. `free/opencode/beam-free`)
- Serves `POST /v1/chat/completions` and `POST /v1/responses`, both streaming (SSE) and non-streaming.
- Dispatches every request through `ctx.llm.stream()`, so credentials, retry policy, token accounting and provider adapters stay in DSH — the gateway itself never talks to a model upstream.
- Accepts image inputs (`image_url` in chat, `input_image` in Responses) as data URLs or remote URLs, admitting them through DSH's own attachment service so normalization and size limits are shared with the app.
- Preserves tool-call history across the Responses → chat conversion: calls and their results are paired into one assistant turn, orphan results degrade to user text, and reasoning is kept on the assistant message. This avoids upstream error `11148` ("tool invocation record mismatch").
- Maps upstream failures to meaningful HTTP statuses and `gateway_hint` messages instead of a blanket 502.

## Install

Inside a DSH workspace:

```bash
git clone https://gitee.com/pcbaby/dsh-llm-gateway.git
dsh plugin --profile desktop add ./dsh-llm-gateway
```

Or in DSH: **Settings → Plugins → Add plugin**, pick the cloned directory.

The bundle declares its own `cordis.patch.yml`, so no manual profile patch edits are needed.

## Configuration

Default config (override in the profile's `cordis.patch.yml` if needed):

```yaml
- id: dsh-llm-gateway
  config:
    host: '127.0.0.1'
    port: 8392
    apiKey: ''
```

`apiKey` is optional; when non-empty, callers must send `Authorization: Bearer <key>`. The default bind is loopback only.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness + number of visible models |
| GET | `/v1/models` | Model list (`<group>/<model>`) |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/responses` | OpenAI Responses API (used by Codex) |

## Verify

```bash
curl http://127.0.0.1:8392/healthz
curl http://127.0.0.1:8392/v1/models | jq '.data[].id'
```

## Using with Codex

Codex's model picker reads a local catalog file rather than `/v1/models`. Generate one from the running gateway and point Codex at it:

```toml
model_provider = "dsh"
model = "buddy/deepseek-v4.1-flash"
model_catalog_json = "/path/to/workbuddy-codex-catalog.json"

[model_providers.dsh]
name = "DSH Gateway"
base_url = "http://127.0.0.1:8392/v1"
wire_api = "responses"
```

A catalog generator (`build-dsh-catalog.cjs`) is kept in the parent workspace on the original machine; it clones Codex's built-in catalog schema and appends the gateway's models.

## Requirements

- A DSH installation with the model providers you want already mounted. This plugin only exposes them locally; it provides no accounts or upstream credentials itself.
- Node.js compatible with DSH (tested on DSH 0.2.2-rc.5).

## License

MIT
