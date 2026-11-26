# LLM gateway

A local OpenAI-compatible HTTP endpoint in front of the DSH `llm` service. External clients — Codex CLI, Codex desktop, ZCode, Claude Code, any OpenAI SDK — therefore see exactly the models this DSH profile offers, with the same credentials, retry policy and token accounting DSH already uses.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness plus the number of models the gateway can see. |
| GET | `/v1/models` | Every registered model, as `provider/model`. |
| POST | `/v1/chat/completions` | OpenAI Chat Completions, streaming or not. |
| POST | `/v1/responses` | OpenAI Responses API, for Codex. |

No upstream is contacted directly — each request is dispatched through `ctx.llm.stream()`, so a provider added or removed in DSH changes what the gateway serves with no restart.

## Model ids

`<provider>/<model>`, for example:

- `deepseek-official/deepseek-v4.1-flash`
- `workbuddy/deepseek-v4.1-flash`
- `our-free-model/kimi-k3`

A bare model id is accepted when exactly one provider offers it; an ambiguous one names the candidate providers in the error.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | Bind address. Keep it on loopback unless you intend LAN exposure. |
| `port` | `8392` | Listen port. |
| `apiKey` | `''` | When non-empty, `Authorization: Bearer <key>` is required. |

## Limitations

- Text and tool calls only; image and file content blocks are not translated from the OpenAI wire format yet.
- `temperature` and `max_tokens` pass through; other sampling parameters are ignored.
- Streaming uses the standard SSE shapes for both wires, including `[DONE]` for chat.
