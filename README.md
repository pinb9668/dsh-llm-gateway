# dsh-llm-gateway

把 DeepSeek Harness（DSH）里**已经接入的每一个模型**，通过一个本机 OpenAI 兼容端点暴露出来。
Codex、ZCode、Claude Code、任何 OpenAI SDK 都能直接用它——用的是 DSH 模型选择器里同一批模型。

> 网关本身不持有任何账号、也不直接对模型上游说话。每个请求都通过 `ctx.llm.stream()`
> 交给 DSH，所以凭据、重试策略、token 计量、供应商适配器都留在 DSH 里。

## 它解决什么问题

DSH 里通常同时挂着好几家模型：官方 DeepSeek、腾讯 WorkBuddy、our-free-model 的免费通道……
但 Codex 这类外部工具只接受**一个** OpenAI 兼容端点。过去要么二选一，要么在中间再叠一层
自制代理（然后重复踩一遍上游协议的坑）。

这个插件把「多供应商」这层复杂度关在网关内部：对客户端只呈现一个 `/v1`，模型 id 用分组前缀区分来源。

## 能力

- **统一目录** —— `GET /v1/models` 列出 `ctx.llm` 里所有 provider/model，按来源分组：
  - `deepseek/` 官方 DeepSeek 路由
  - `buddy/` WorkBuddy（腾讯）
  - `free/` our-free-model 及其聚合通道（如 `free/opencode/beam-free`）
- **两套协议** —— `/v1/chat/completions` 与 `/v1/responses`，都支持流式（SSE）与非流式。
  Codex 只认后者。
- **真正的多模态** —— 图片走 DSH 自己的附件服务（`ctx.attachments`），
  规范化与体积上限与 DSH 应用内一致。**工具返回的截图模型真能看到**，
  不是占位符：图片会从 `function_call_output` 里摘出来、另起一条 user 消息送上游
  （Chat 协议的 tool 消息不允许带图）。
- **工具调用历史可靠** —— 调用与结果成对、孤儿结果清理、缺结果的调用补占位、
  顺序颠倒自动重排。这四件事各自都会触发上游 `11148`。
- **推理档位不丢** —— 上游有的档位，客户端一个不少：模型声明几档就暴露几档（槽位映射），
  客户端选第 N 档，网关换回该模型自己的第 N 个档位。
- **失败分类可执行** —— 上游错误码映射成有意义的状态（402 余额 / 429 限流 /
  400 上下文超长 / 400 工具不匹配 …），每条都带一句「重发有没有用、现在该做什么」。
- **不该重试的明说不重试** —— 命中确定性失败时返回 `x-should-retry: false`，
  免得客户端把同一份请求重打五轮（合计约 15 秒）换回同一句拒绝。
- **缓存命中如实上报** —— `cached_tokens` 同时写进 OpenAI 与国内网关两种字段名，
  哪个区域都不会显示成 0。

## 安装

在 DSH 工作区里：

```bash
git clone https://gitee.com/pcbaby/dsh-llm-gateway.git
dsh plugin --profile desktop add ./dsh-llm-gateway
```

或在 DSH 界面里：**设置 → 插件 → 添加插件**，选中克隆下来的目录。

bundle 自带 `cordis.patch.yml`，不需要手改 profile。

## 配置

默认值（需要时在 profile 的 `cordis.patch.yml` 里覆盖）：

```yaml
- id: dsh-llm-gateway
  config:
    host: '127.0.0.1'
    port: 8392
    apiKey: ''
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 绑定地址；默认只绑回环 |
| `port` | `8392` | 监听端口 |
| `apiKey` | 空 | 非空时要求 `Authorization: Bearer <key>` |

## 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/healthz` | 存活 + 可见模型数量 |
| GET | `/v1/models` | 模型目录（`<group>/<model>`） |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/responses` | OpenAI Responses API（Codex 用这条） |

## 快速验证

```bash
curl http://127.0.0.1:8392/healthz
curl http://127.0.0.1:8392/v1/models | jq '.data[].id'
```

一次真实补全：

```bash
curl http://127.0.0.1:8392/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"buddy/deepseek-v4.1-flash","input":"只回复两个字：就绪","stream":false}'
```

## 接 Codex

Codex 的模型选择器读的是本地目录文件，不是 `/v1/models`。用仓库里的
`build-dsh-catalog.cjs` 从运行中的网关生成一份：

```bash
node build-dsh-catalog.cjs
```

然后：

```toml
# 顶层，必须在任何 [table] 之前
model = "buddy/deepseek-v4.1-flash"
model_provider = "dsh"
model_catalog_json = "/path/to/dsh-llm-gateway-models.json"

[model_providers.dsh]
name = "DSH Gateway"
base_url = "http://127.0.0.1:8392/v1"
wire_api = "responses"
```

两个容易踩的坑：

1. **顶层三个键必须写在任何 `[table]` 之前**。TOML 里裸 key 归属于最后一个已声明的表，
   放到 `[mcp_servers.*]` 后面就变成那个 MCP 的字段，Codex 会报 `provider: openai` 然后
   一直重连 OpenAI。
2. **目录是生成物**。上游模型增删、改了档位之后要重跑 `build-dsh-catalog.cjs`，
   再重启 ChatGPT（它的 app-server 只在启动时读一次）。

## 已做的防护

这些不是凭空加的，每一条都对应一次真实故障：

| 场景 | 症状 | 处理 |
|---|---|---|
| 工具返回截图 | 上游 `11115 prompt is too long` | 图片走附件、另起 user 消息 |
| 只有思考没有正文 | 界面显示空回复、回合静默结束 | 回 `response.failed` / `empty_reasoning_only` |
| 历史里有空 text 段 | 上游 `11151 empty content` | 出站补一个空格（不删段） |
| 调用与结果不成对 | 上游 `11148` | 补占位 / 删孤儿 / 重排顺序 |
| 请求体过大 | 500 或连接重置 | 明确回 413 |
| 确定性失败被反复重试 | 白烧请求、拖慢恢复 | `x-should-retry: false` |

## 要求

- 一个已经挂好目标 provider 的 DSH 安装。本插件只把它们本地暴露出来，
  不提供账号或上游凭据。
- 与 DSH 兼容的 Node.js（在 DSH 0.2.2-rc.5 上验证）。

## 许可

MIT
