#!/usr/bin/env node
/**
 * Build a Codex model_catalog_json from the DSH LLM gateway's /v1/models.
 *
 * Cross-platform (Node.js only, no shell utilities). Usage:
 *   node build-dsh-catalog.cjs [--gateway http://127.0.0.1:8392] [--out /path/to/catalog.json]
 *
 * Defaults: gateway from DSH_LLM_GATEWAY env or http://127.0.0.1:8392;
 * out path parsed from `model_catalog_json` in ~/.codex/config.toml.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function parseArgs(argv) {
  const args = { gateway: process.env.DSH_LLM_GATEWAY || 'http://127.0.0.1:8392', out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--gateway' && argv[i + 1]) args.gateway = argv[++i];
    if (argv[i] === '--out' && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

function findCodex() {
  const candidates = [];
  if (process.env.CODEX_CLI_PATH) candidates.push(process.env.CODEX_CLI_PATH);
  candidates.push('codex');
  const home = os.homedir();
  // ChatGPT.app bundles the Codex CLI on macOS.
  candidates.push(path.join(home, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'));
  candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error('codex CLI not found; set CODEX_CLI_PATH or put codex on PATH');
}

/** Extract the first complete JSON value from raw text (skips log noise). */
function firstJsonValue(raw) {
  const start = raw.search(/[[{]/u);
  if (start === -1) throw new Error('no JSON value in command output');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON value in command output');
}

/** Parse `codex debug models --bundled` output; it may be {models:[…]} or a bare array. */
function parseBundled(raw) {
  let parsed = firstJsonValue(raw);
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.models)) {
    parsed = parsed.models;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('bundled model catalog is empty');
  return parsed;
}

function catalogPathFromConfig() {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  const text = fs.readFileSync(configPath, 'utf8');
  const match = text.match(/^\s*model_catalog_json\s*=\s*["']([^"']+)["']/m);
  if (!match) throw new Error(`model_catalog_json not found in ${configPath}`);
  return match[1];
}

async function fetchModels(gateway) {
  const url = `${gateway.replace(/\/+$/u, '')}/v1/models`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.data)) throw new Error('unexpected /v1/models response');
  return payload.data;
}

/**
 * Pick the most vanilla bundled entry as the template.
 *
 * Most shipped entries set `tool_mode: "code_mode_only"`: Codex then drives the
 * model through its code-mode protocol (`functions.*` namespaces, JS cells).
 * Third-party models do not speak that protocol, so they answer by writing the
 * call as text — which renders as `<tool_calls:…>` noise in the transcript.
 * Entries without `tool_mode` use plain function calling, which is what the
 * gateway forwards.
 */
function pickTemplate(entries) {
  const plain = entries.find(
    (entry) => entry.tool_mode === undefined || entry.tool_mode === null,
  );
  return plain ?? entries[0];
}

/** Fields that would make Codex treat a third-party model as a Codex-native one. */
const CODEX_ONLY_FIELDS = [
  'multi_agent_version',
  'multi_agent_reasoning_effort',
];

/** Clone a bundled template entry, overriding only the fields we must control. */
function cloneEntry(template, model, index) {
  const id = model.id;
  const group = String(id).split('/')[0];
  const entry = JSON.parse(JSON.stringify(template));
  entry.slug = id;
  // 网关现在返回 name（如 "Hy4 flash · x0.00"）；拼上分组前缀，
  // 让下拉框里一眼看出这条请求走的是哪一组。
  const groupLabel = group === 'buddy' ? 'Buddy' : group === 'deepseek' ? 'DeepSeek' : 'Free';
  const rawName = typeof model.name === 'string' && model.name !== '' ? model.name : id;
  entry.display_name = `${groupLabel} · ${rawName}`;
  entry.visibility = 'list';
  entry.supported_in_api = true;
  entry.description = `${group} group model exposed by the local DSH LLM gateway`;
  // `priority` orders the picker and is required by the catalog schema; keep one
  // unique, deterministic value per entry instead of dropping it.
  entry.priority = index + 1;
  // Plain function calling and ordinary text responses only.
  entry.tool_mode = null;
  entry.use_responses_lite = false;
  entry.apply_patch_tool_type = null;
  entry.web_search_tool_type = 'text_and_image';
  for (const field of CODEX_ONLY_FIELDS) delete entry[field];
  entry.experimental_supported_tools = [];
  entry.supports_search_tool = false;
  entry.supports_experimental_context = false;
  entry.supports_reasoning_effort_updates = false;
  entry.include_skills_usage_instructions = false;
  entry.include_plugin_usage_instructions = false;
  entry.include_apps_usage_instructions = false;
  if ('upgrade' in entry) entry.upgrade = null;
  if ('availability_nux' in entry) entry.availability_nux = null;
  // 推理档位：网关自述 → Codex 认识的规范名。
  //
  // 为什么必须映射：Codex 的档位枚举是固定的
  //   none / minimal / low / medium / high / xhigh / max / ultra / persistent
  // 它在读目录时**静默丢弃**不认识的档位名。而网关会把上游的原始叫法原样透传，
  // 于是 `disabled`、`off`、`light`、`balanced`、`deep` 这些全被吞掉，
  // 滑块只剩零星几个落点（实测 free/deepseek-v4.1-flash-free 声明 4 档却只画 2 个）。
  //
  // 映射原则是保留语义与先后顺序，不改变强弱关系：
  //   disabled / off        → none     （关闭思考；这是 Codex 唯一的「关」档）
  //   light                 → low      （rank 表里 light=2、low=3，是最弱的有档位档）
  //   balanced              → medium   （中档）
  //   deep                  → high     （高档）
  // 其余（minimal/low/medium/high/xhigh/max/ultra）本来就是规范名，原样保留。
  const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const EFFORT_ALIAS = {
    disabled: 'none',
    off: 'none',
    light: 'low',
    balanced: 'medium',
    deep: 'high',
  };
  const CANONICAL = new Set(['none', ...EFFORT_ORDER, 'persistent']);
  const declared = Array.isArray(model.reasoning_supported_efforts)
    ? model.reasoning_supported_efforts.filter((e) => typeof e === 'string' && e !== '')
    : [];

  // 逐个规范化并按出现顺序去重（上游顺序表达它自己的强弱次序，保留它）。
  const levels = [];
  for (const raw of declared) {
    const mapped = EFFORT_ALIAS[raw] ?? raw;
    if (!CANONICAL.has(mapped)) continue; // 仍不认识的直接丢，避免脏数据进目录
    if (!levels.includes(mapped)) levels.push(mapped);
  }
  if (levels.length === 0) levels.push('low', 'medium', 'high', 'max');

  const usable = EFFORT_ORDER.filter((e) => levels.includes(e));
  entry.supported_reasoning_levels = levels.map((effort) => ({ effort, description: effort }));
  // 用户要求：默认取该模型最高档，而不是拍一个固定值。
  entry.default_reasoning_level =
    usable.length > 0 ? usable[usable.length - 1] : levels.includes('none') ? 'none' : 'high';

  // 上下文窗口用模型标称值；拿不到才用模板兜底。
  if (typeof model.context_length === 'number' && model.context_length > 0) {
    entry.context_window = model.context_length;
    entry.max_context_window = model.context_length;
  }
  // 输出上限优先用上游自述；没有就按窗口 1/4 收口（Codex 会当 truncation limit）。
  const contextWindow = entry.context_window ?? 1_000_000;
  const declaredOut = typeof model.max_output_tokens === 'number' && model.max_output_tokens > 0
    ? model.max_output_tokens
    : Math.min(64_000, Math.floor(contextWindow / 4));
  entry.max_output_tokens = Math.min(declaredOut, Math.floor(contextWindow / 4));
  entry.truncation_policy = { mode: 'tokens', limit: entry.max_output_tokens };
  return entry;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const codex = findCodex();
  const bundledRaw = execFileSync(codex, ['debug', 'models', '--bundled'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000,
  });
  const template = pickTemplate(parseBundled(bundledRaw));
  const models = await fetchModels(args.gateway);
  const entries = models.map((model, index) => cloneEntry(template, model, index));
  const catalog = { models: entries };
  const out = args.out || catalogPathFromConfig();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const temporary = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, out);
  process.stdout.write(`Wrote ${entries.length} models to ${out}\n`);
}

main().catch((error) => {
  process.stderr.write(`build-dsh-catalog: ${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
