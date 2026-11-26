# dsh-llm-gateway

把 DeepSeek Harness（DSH）里**已经接好的每一个模型**，用一个本机 OpenAI 兼容端点暴露出来。
Codex、ChatGPT 桌面端、任何 OpenAI SDK 都能直接用它，模型就是 DSH 模型选择器里那一批。

> 网关自己不持有账号、不保存上游凭据、也不直接对模型上游说话。每个请求都通过
> `ctx.llm.stream()` 交回 DSH，所以凭据、重试策略、token 计量、供应商适配器都留在 DSH 里。

```text
Codex / ChatGPT 桌面端 / OpenAI SDK
        │  http://127.0.0.1:8392/v1
        ▼
   dsh-llm-gateway（协议翻译 + 历史整形 + 失败分类）
        │  ctx.llm.stream()
        ▼
   DSH llm 服务 → deepseek / workbuddy / our-free-model …
```

## 目录

- [它解决什么问题](#它解决什么问题)
- [能力](#能力)
- [安装](#安装)
- [配置](#配置)
- [端点](#端点)
- [模型 id 与分组](#模型-id-与分组)
- [推理档位：槽位映射](#推理档位槽位映射)
- [快速验证](#快速验证)
- [接 Codex](#接-codex)
- [故障对照表](#故障对照表)
- [已知限制](#已知限制)
- [排障](#排障)
- [开发与测试](#开发与测试)
- [要求](#要求)
- [许可](#许可)

## 它解决什么问题

DSH 里通常同时挂着好几家模型：官方 DeepSeek、腾讯 WorkBuddy、our-free-model 的免费聚合通道……
但 Codex 这类外部工具只接受**一个** OpenAI 兼容端点。过去要么二选一，要么在中间再叠一层自制代理，
然后把上游协议里的坑重新踩一遍。

这个插件把「多供应商」这层复杂度关在网关内部：对客户端只呈现一个 `/v1`，模型 id 用分组前缀区分来源。
协议翻译、工具调用历史整形、错误分类这些容易踩坑的部分全在网关里做掉。

## 能力

- **统一目录** —— `GET /v1/models` 列出 `ctx.llm` 里所有 provider 的 model，按来源分组
  （`deepseek/`、`buddy/`、`free/`），并带上真实的上下文窗口、输出上限与推理档位。
- **两套协议** —— `/v1/chat/completions` 与 `/v1/responses`，都支持流式（SSE）与非流式。Codex 用后者。
- **推理档位不丢** —— 模型声明几档就暴露几档名为 `low/medium/high/xhigh/ultra` 的槽位，
  客户端选第 N 档，网关换回该模型自己的第 N 个真档位。细节见[槽位映射](#推理档位槽位映射)。
- **工具调用历史可靠** —— 补缺结果的调用、删孤儿结果、按发起者重排、空 text 段补位，
  四件事各自都会触发上游 `11148` / `11151`。
- **工具返回的截图能进模型** —— 图片从 `function_call_output` 里摘出来，经 DSH 附件服务落成真实附件，
  另起一条 user 消息送上（Chat 协议的 tool 消息不允许带图），并顺手把它压成附件的原消息里补一句占位，
  避免 tool 结果变空。
- **失败可执行** —— 上游错误码映射成有意义的状态（402 余额 / 429 限流 / 400 上下文超长 / 400 工具不匹配 …），
  每条只带一句「重发有没有用、现在该做什么」。
- **不该重试的明说不重试** —— 命中确定性失败时响应带 `x-should-retry: false`，
  免得客户端把同一份请求重打五轮换回同一句拒绝。
- **缓存命中如实上报** —— `cached_tokens` 同时写进 OpenAI 与国内网关两种字段名，两边都不会显示成 0。

### 一次请求会经过哪些整形

| 步骤 | 处理 | 为什么 |
|---|---|---|
| 协议转换 | Chat `messages` / Responses `input` → DSH 消息数组；`developer` 与 `system` 都作为 system 提示词 | 两条协议的形状差异全部在这里抹平 |
| 工具配对修复 | 补缺结果的调用（占位正文 `(tool call was interrupted before it returned)`）、删孤儿 tool 结果、把 tool 结果挪到发起它的 assistant 之后 | 上游对不成对调用一律 `11148` |
| 空段补位 | 空的 text 段填一个空格，整条消息没有块时补一个空格块 | 上游对空 text 段判 `11151 empty content` |
| 图片落地 | 内联 `data:image/` 与 http(s) 图片摘出来，走 `ctx.attachments.saveImage()`，合成一条 user 消息追加到末尾 | tool 消息不能带图；base64 混在正文里会撑爆上下文 |
| 图片预算 | 超出路由预算（默认 50 张 / 20 MB base64）时**从最老的开始省略**，换成占位文本 | 否则 DSH 适配器抛 `IMAGE_OFFLOAD_REQUIRED`，而它的会话级恢复链在无状态网关上永远修不好同一份历史 |
| 调用上游 | `ctx.llm.stream({ provider, model, messages, reasoningEffort, maxTokens, temperature, tools })` | 唯一出口，凭据不经过网关 |
| 回写 | 流式逐块转 SSE；非流式聚合后一次性返回；usage 按协议换算 | 客户端看到的永远是标准 OpenAI 形状 |

## 安装

### 从源码目录安装

```bash
git clone https://gitee.com/pcbaby/dsh-llm-gateway.git
dsh plugin --profile desktop add ./dsh-llm-gateway
```

### 在 DSH 界面里安装

**设置 → 插件 → 添加插件**，选中克隆下来的目录。

### 从插件市场安装

插件市场（`https://dshopen.org/index.json`）收录后可以直接搜索
**DSH LLM gateway** 安装，无需克隆仓库。

bundle 自带 `cordis.patch.yml`，安装时自动插入插件行，不需要手改 profile。
装完 **重启 DSH**，网关才会开始监听。

## 配置

默认值（需要时在 profile 的 `cordis.patch.yml` 里覆盖）：

```yaml
- insert:
    - id: dsh-llm-gateway
      name: '@morgan9668/dsh-llm-gateway'
      config:
        host: '127.0.0.1'
        port: 8392
        apiKey: ''
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 绑定地址。默认只绑回环，局域网内其它机器访问不到 |
| `port` | `8392` | 监听端口；非法值静默回退到默认值，不会报错 |
| `apiKey` | 空 | 为空表示不鉴权；非空时要求 `Authorization: Bearer <key>` 全串精确匹配 |
| `maxBodyBytes` | 256 MiB | 单个请求体上限。Codex 每轮重发整段历史，带图会话会很大；超过就回 413。缩小它是给暴露到公网的实例加一道闸 |
| `maxRequestImages` | `50` | 一条请求允许携带的图片数量上限；超过时省略最老的。与 DSH pi-ai 适配器的默认值对齐 |
| `maxRequestImageBytes` | `20 MiB` | 一条请求的图片 base64 载荷总量上限；超过时省略最老的。留 5% 余量以吸收适配器重新编码的差异 |

> 网关**不导出 Config schema**：所有值从插件行的 `config` 里读，缺字段就用默认值。
> 因此写错字段名不会报错，只会被忽略——改完记得看日志里的 `listening on http://…`。

### 安全边界

- 默认只绑 `127.0.0.1`，外部网络进不来。改 `host` 前先想清楚：这个端点会让调用方以你的账号配额随意调用模型。
- `apiKey` 是**明文全串比较**，不是哈希、不带时效：别把它写进会共享出去的配置。
- 网关**不实现 CORS**，也没有 `OPTIONS` 预检分支。浏览器页面直连会被同源策略挡住；
  要跨源请自己在前面放一层反向代理，不要指望这里放宽。
- 网关不落盘任何上游凭据；唯一的持久副作用是一条本地日志（见[排障](#排障)）。

## 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/healthz` | 存活检查，返回 `{ok, service, models}`，`models` 是当前可见模型条目数 |
| GET | `/v1/models` | 模型目录 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/responses` | OpenAI Responses API（Codex 用这条） |

所有路径都吃掉尾部斜杠；其它方法/路径返回 404 `no route for <METHOD> <path>`。
配了 `apiKey` 时**任何路径都要带上 Bearer**，`/healthz` 也不例外。

### `/v1/models` 的字段

```json
{
  "object": "list",
  "data": [
    {
      "id": "buddy/deepseek-v4.1-flash",
      "object": "model",
      "created": 0,
      "owned_by": "buddy",
      "name": "DeepSeek-V4.1-Flash",
      "context_length": 1048576,
      "max_output_tokens": 256000,
      "reasoning_supported_efforts": ["low", "medium", "high", "xhigh"],
      "reasoning_default_effort": "high"
    }
  ]
}
```

- `owned_by` 是**分组名**（`deepseek` / `buddy` / `free`），不是 provider id。
- `created` 恒为 `0`，是占位字段。
- `context_length` / `max_output_tokens` / 两个 `reasoning_*` 字段在拿不到模型详情时**整字段缺席**，
  不会出现 `null`。后两个是给 Codex 目录生成器读的非标准扩展字段。

### 请求参数支持情况

| 参数 | Chat | Responses | 说明 |
|---|---|---|---|
| `model` | ✅ 必填 | ✅ 必填 | 见[模型 id 与分组](#模型-id-与分组) |
| `stream` | ✅ | ✅ | 只认布尔 `true`；字符串 `"true"` 无效 |
| `max_tokens` | ✅ | ⚠️ 用 `max_output_tokens` | Responses 体里的 `max_tokens` 会被忽略 |
| `temperature` | ✅ | ✅ 透传 | |
| `reasoning_effort` / `reasoning.effort` | ✅ | ✅ | 传的是槽位名，不是上游真档位名 |
| `tools` | ✅ | ✅ | 只支持 function 工具，两种写法都认 |
| `instructions` / `input` | — | ✅ | `instructions` 变成首条 system 消息 |
| `n`、`stop`、`top_p`、`seed`、`presence_penalty`、`frequency_penalty`、`response_format`、`logprobs`、`user`、`metadata`、`tool_choice`、`parallel_tool_calls`、`previous_response_id`、`store`、`include`、`background` | ❌ | ❌ | **静默忽略**，不报错也不生效 |

`tools` 只接受两种形状：`{"type":"function","function":{...}}` 与裸 `{name, description, parameters}`。
`strict`、`web_search`、`file_search`、`computer_use`、`custom` 等一并丢弃。

## 模型 id 与分组

公共 id 是 `<分组>/<模型>`：

| 来源 provider | 前缀 | 示例 |
|---|---|---|
| `deepseek-official`、`deepseek-account`、`deepseek-flash`、`deepseek-v4.1-flash`、`deepseek-v4.1-flash-free` | `deepseek/` | `deepseek/deepseek-flash` |
| `workbuddy`、`workbuddy-global` | `buddy/` | `buddy/deepseek-v4.1-flash` |
| 其余（`our-free-model` 及其聚合通道） | `free/` | `free/opencode/beam-free` |

- 模型 id 自带的 `/` 原样保留在前缀之后，所以 `free/opencode/beam-free` 和 `free/reflection/beam-free` 不冲突。
- 分组是**硬编码集合**，新加的 provider 默认落进 `free/`，不按名字猜。
- 目录缓存 **10 秒**，期间并发请求共用一次加载；上游增删模型最迟 10 秒后可见。

请求里的 `model` 按三步解析，命中多条立刻 400 `ambiguous`：

1. 精确匹配公共 id（`buddy/deepseek-v4.1-flash`）；
2. 匹配裸模型 id（`deepseek-v4.1-flash`，可绕过分组）；
3. 按 `<provider>/<model>` 拆分（`workbuddy/deepseek-v4.1-flash`）。

`deepseek` / `buddy` / `free` 是分组前缀，**不能**当 provider 名寻址，这样写会明确报错而不是静默落到某个 provider。
找不到模型时返回 404 并提示去 `GET /v1/models` 查可用 id。

## 推理档位：槽位映射

Codex 桌面端对档位名有两道闸门，都不受网关控制：固定枚举 `ReasoningEffort` 会**静默丢弃**不认识的档位名；
模型选择器的可见档位再过一道白名单，`none` / `max` / `minimal` 都不在里面。
于是「上游有 4 档」的模型在界面上经常只剩两档。

网关因此不再转发上游的原始档位名，而是发**固定槽位序列**：

```text
槽位: low → medium → high → xhigh → ultra
```

模型有几档就发几个槽位，第 N 个槽位始终叫同一个名字。客户端选第 k 个槽位，网关转发时换回该模型自己的第 k 个档位。
档位数超过 5 个时按等距抽样取 5 个代表，保证最强档与两端一定被覆盖。

所以 `/v1/models` 里的 `reasoning_supported_efforts` 是**槽位名**，不是上游真档位名；
客户端传真档位名（`none`、`max`）不会被映射，请求仍然成功，只是不指定档位。

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

流式（能看到 `event: response.created` … `response.completed`）：

```bash
curl -N http://127.0.0.1:8392/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"buddy/deepseek-v4.1-flash","input":"说一句你好","stream":true}'
```

## 接 Codex

Codex 的模型选择器读的是本地目录文件，不是 `/v1/models`。用仓库里的 `build-dsh-catalog.cjs`
从运行中的网关生成一份：

```bash
node build-dsh-catalog.cjs
# 或显式指定：
node build-dsh-catalog.cjs --gateway http://127.0.0.1:8392 --out ~/.codex/dsh-llm-gateway-models.json
```

脚本做的事：读网关 `/v1/models` → 用 `codex debug models --bundled` 取一份目录模板 →
逐个模型克隆并覆写（窗口、输出上限、档位、可见性）→ 原子写回。

参数与环境变量：

| 项 | 默认 | 说明 |
|---|---|---|
| `--gateway` | `$DSH_LLM_GATEWAY` 或 `http://127.0.0.1:8392` | 网关地址，尾部 `/` 会自动去掉 |
| `--out` | 从 `~/.codex/config.toml` 的 `model_catalog_json` 里解析 | 找不到该键直接报错 |
| `CODEX_CLI_PATH` | 依次尝试 `codex`（PATH）与 macOS 上 ChatGPT.app 内置的 CLI | 其它平台必须设这个或把 `codex` 放进 PATH |

> 脚本**不发送认证头**。网关配了 `apiKey` 时会拿到 401，此时要么临时清空 `apiKey`，要么手工导出目录。

然后：

```toml
# 顶层，必须在任何 [table] 之前
model = "buddy/deepseek-v4.1-flash"
model_provider = "dsh"
model_catalog_json = "/Users/you/.codex/dsh-llm-gateway-models.json"

[model_providers.dsh]
name = "DSH Gateway"
base_url = "http://127.0.0.1:8392/v1"
wire_api = "responses"
```

三个容易踩的坑：

1. **顶层三个键必须写在任何 `[table]` 之前**。TOML 里裸 key 归属于最后一个已声明的表，
   放到 `[mcp_servers.*]` 后面就变成那个 MCP 的字段，Codex 会报 `provider: openai` 然后一直重连 OpenAI。
2. **目录是生成物**。上游模型增删、改了档位之后要重跑脚本，再重启 ChatGPT
   （它的 app-server 只在启动时读一次）。
3. **默认档位以脚本为准**。脚本取 `EFFORT_ORDER` 里出现的最高档作为默认，不读网关的
   `reasoning_default_effort`；想换默认档就在 Codex 里手选。

## 故障对照表

每一条都对应一次真实故障，不是凭空加的防护。

| 上游症状 | 网关怎么处理 | 客户端看到什么 |
|---|---|---|
| `11115 prompt is too long` | 图片先被摘出正文走附件，另起 user 消息 | 400 `PROMPT_TOO_LONG` + 「压缩历史或新建任务，重发没用」 |
| `11148 tool invocation …` | 补占位结果 / 删孤儿 / 重排顺序 / 空段补位 | 400 `TOOL_MISMATCH` + 「新建任务，重发还是被拒」 |
| `11151 empty content` | 出站前把空 text 段补成一个空格（不删段） | 400 `EMPTY_CONTENT`（说明这是网关修不了的那种形态） |
| `11128 unapproved channel` | 不做自动绕过，如实上报 | 400 `CHANNEL_REJECT` + 「改系统提示或换模型」 |
| `11135 invalid image` | 图片体积/类型在入站就卡（8 MB、png/jpeg/webp/gif） | 400 `IMAGE_INVALID` + 「换小图或去掉图」 |
| 余额不足 / 额度用尽 | 归为账号失败 | 402 `ACCOUNT_QUOTA` + 「充值或换模型组」 |
| 429 / 冷却中 | 归为限流 | 429 `RATE_LIMIT` + 「等冷却，立刻重发还是同一句」 |
| 只有思考没有正文 | 判为空回答，不当成功 | 502 `empty_reasoning_only`，让客户端按自己的策略重试 |
| 请求体过大 | `content-length` 与实际字节各卡一次，边读边计不缓冲整个 body | 413 `request body too large (limit 268435456 bytes)` + `x-should-retry: false` |
| 请求体不是合法 JSON | 直接拒绝 | 400 `request body is not valid JSON` |
| 确定性失败被反复重试 | 响应头显式拒绝 | `x-should-retry: false`、`retry-after: 0` |

前七条（`PROMPT_TOO_LONG`、`TOOL_MISMATCH`、`CHANNEL_REJECT`、`IMAGE_INVALID`、`EMPTY_CONTENT`、
`ACCOUNT_QUOTA`、`RATE_LIMIT`）都带 `x-should-retry: false`，**413 也带**；5xx 与网络类**不带**，保持可重试。

> 这个头只能出现在**非流式**响应上：流式响应头早就发出去了，收尾时只能改事件体的内容。

> 413 这一条值得单独说：同一份历史重发还是超限，重试没有任何意义。缺了这个头时
> Codex 会按状态码策略重连五轮（界面上显示「正在重新连接 5/5」），每轮把几十 MB
> 重新传一遍，最后仍拿到同一句拒绝。请求体上限默认 256 MiB，可用 `maxBodyBytes` 调整。

## 已知限制

写下来是为了省掉你的排查时间，不是待办清单：

- **无状态**：不支持 `previous_response_id` / `store` / 服务端会话，每轮都要重放完整历史。
- **入站 `reasoning` 项被丢弃**：上游推理内容是加密私有载荷，不能回放；客户端要保留就自己存。
- **出站推理只有 `summary`**：不产出 `encrypted_content`，严格校验该字段的客户端会认为没有推理内容。
- **Responses 消息里的图片只变占位文本**：只有 `function_call_output` 里的图片会被落成真实附件。
  这是有意的取舍——工具截图是刚需，用户贴图请走 DSH 应用内。
- **所有图片都被集中到最后一条合成 user 消息**，原始出现位置不再保留。
- **`max-tokens` 截断在 Responses 里报 `completed`**，不报 `incomplete`。
- **被省略的图片不会自己回来**：图片总量超过 `maxRequestImages` / `maxRequestImageBytes` 时，
  网关从最老的开始换成占位文本 `[image omitted: over the route image budget]`。这是每次请求
  重新计算的确定性结果，不是持久标记——历史变短后，新请求里更老的图仍会被省略。
- **非流式「半截正文 + 上游失败」按成功返回**：可能是 `stop` 且带半截答案，客户端无法从 `finish_reason` 区分。
- **同分组内两个 provider 暴露同名 model 时该模型不可达**：精确匹配命中多条即 400，拆分寻址又被分组前缀规则挡住。
- **流式无心跳帧**：长思考模型可能让连接长时间静默，中间代理可能先断。
- **Chat 流式不处理适配器以 `{type:'error'}` chunk 上报的错误**，这种情况下会退化成空的 `stop`。

## 排障

- 日志写在 `/tmp/dsh-llm-gateway.log`（带时间戳，只记启动、目录加载与失败原因）。
- 想看完整堆栈：设环境变量 `DSH_GATEWAY_DEBUG=1`，异常栈会打到 DSH 的 stderr。
- 端口被占用时插件不会崩，但也不会换端口——看日志里有没有 `listening on http://…`。
- 模型列表空：说明 `ctx.llm.listProviders()` 没返回任何 provider，或 `listModels` 全失败，
  日志里会有 `listModels(<provider>) failed`。目录加载失败也会缓存 10 秒，别急着反复重启。

## 开发与测试

```bash
npm test        # 等价于下面三条
node tests/stream-failure.mjs
node tests/body-limit.mjs
node tests/image-budget.mjs
```

`stream-failure.mjs` 六个用例覆盖流式失败上报的回归：上游失败必须发 `response.failed` / `error` 帧
而不是伪装成 `response.completed` / `finish_reason: stop`，有半截正文时也一样；正常回答不受影响。

`body-limit.mjs` 四个用例真正起一个网关，覆盖请求体上限：超限必须回 413 且带
`x-should-retry: false` 与 `retry-after: 0`；`content-length` 缺失（分块上传）时仍按实际字节拦截；
上限可由 `maxBodyBytes` 调整；默认值容得下几十 MB 的带图历史。

`image-budget.mjs` 四个用例覆盖路由图片预算：数量超限时省略最老的并保留最新的；
base64 字节超限时同样触发省略；未超限时一张不动；省略后确实落在预算内。

未覆盖的部分（改代码时自己补测）：请求转换与配对修复、槽位换算、路由解析、附件落地、状态码映射表、
认证。

`index.js` 单文件、零依赖，只用到 Node 内建模块与 Web 标准（`fetch`、`Response`、`ReadableStream`）。

## 要求

- 一个已经挂好目标 provider 的 DSH 安装。本插件只把它们本地暴露出来，不提供账号或上游凭据。
- Node.js `>=22.14.0`。在 DSH `0.2.2-rc.5` 上验证；声明兼容范围 `>=0.2.2-rc.1 <0.3.0-0`。

## 许可

MIT
