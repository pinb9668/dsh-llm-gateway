#!/usr/bin/env node
/**
 * 流式失败上报的回归测试。
 *
 * 背景：网关的流式路径曾无条件发 response.completed / finish_reason=stop，
 * 把"余额不足、配额用尽、上游异常"伪装成"成功但内容为空"。Codex 只走流式，
 * 于是界面上表现为模型突然不说话了。
 *
 * 这些用例直接驱动 handleResponsesStream / handleChatStream，用假的 DSH 流
 * 触发失败 finish。
 */

import assert from 'node:assert/strict';

import { handleChatStream, handleResponsesStream } from '../index.js';

function sinkCollector() {
  const chunks = [];
  return {
    sink: { write: (text) => chunks.push(text) },
    text: () => chunks.join(''),
  };
}

/** 假的 ctx.llm.stream()：只产出一个失败 finish。 */
async function* failingStream(failure) {
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
  yield { type: 'finish', reason: { kind: 'error', failure } };
}

/** 正常结束 + 正文。 */
async function* okStream() {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: 'hello' };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** 上游失败并带有半截正文（已开始回答、然后断掉）。 */
async function* partialThenFail(failure) {
  yield { type: 'text-delta', index: 0, text: 'partial answer' };
  yield { type: 'finish', reason: { kind: 'error', failure } };
}

const FAILURE = { message: 'Free usage limit reached.', code: 'EMPTY_RESPONSE' };

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('Responses 流式：上游失败必须发 response.failed，而不是 completed', async () => {
  const { sink, text } = sinkCollector();
  await handleResponsesStream('m', failingStream(FAILURE), sink);
  const out = text();
  assert.ok(out.includes('response.failed'), `should emit response.failed, got: ${out.slice(0, 300)}`);
  assert.ok(!out.includes('response.completed'), 'must not emit response.completed');
  assert.ok(out.includes('Free usage limit reached.'), 'must carry the upstream message');
});

test('Responses 流式：失败时 status 是 failed 且带 error', async () => {
  const { sink, text } = sinkCollector();
  await handleResponsesStream('m', failingStream(FAILURE), sink);
  // 按 SSE 事件块解析：每块是 "event: <type>\ndata: <json>"。
  const events = text()
    .split('\n\n')
    .map((block) => {
      const typeLine = block.split('\n').find((line) => line.startsWith('event: '));
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
      if (typeLine === undefined || dataLine === undefined) return undefined;
      return { type: typeLine.slice('event: '.length).trim(), payload: JSON.parse(dataLine.slice('data: '.length)) };
    })
    .filter(Boolean);
  const failed = events.find((event) => event.type === 'response.failed');
  assert.ok(failed !== undefined, 'should have a response.failed event');
  assert.equal(failed.payload.response.status, 'failed');
  assert.equal(failed.payload.response.error.message, 'Free usage limit reached.');
  assert.equal(failed.payload.response.output.length, 0);
});

test('Responses 流式：正常回答仍然 response.completed 且带正文', async () => {
  const { sink, text } = sinkCollector();
  await handleResponsesStream('m', okStream(), sink);
  const out = text();
  assert.ok(out.includes('response.completed'));
  assert.ok(!out.includes('response.failed'));
  assert.ok(out.includes('hello'));
});

test('Responses 流式：已出半截正文后失败，也如实报 failed（不冒充完整回答）', async () => {
  const { sink, text } = sinkCollector();
  await handleResponsesStream('m', partialThenFail(FAILURE), sink);
  const out = text();
  assert.ok(out.includes('response.failed'), 'partial answer must not be certified as completed');
  assert.ok(!out.includes('response.completed'));
});

test('Chat 流式：上游失败必须发 error 帧，而不是 finish_reason=stop', async () => {
  const { sink, text } = sinkCollector();
  await handleChatStream('m', failingStream(FAILURE), sink);
  const out = text();
  assert.ok(out.includes('"error"'), `should emit an error frame, got: ${out.slice(0, 300)}`);
  assert.ok(!out.includes('"finish_reason":"stop"'), 'must not look like a normal empty answer');
  assert.ok(out.includes('Free usage limit reached.'));
  assert.ok(out.trimEnd().endsWith('data: [DONE]'));
});

test('Chat 流式：正常回答仍然以 finish_reason=stop 收尾', async () => {
  const { sink, text } = sinkCollector();
  await handleChatStream('m', okStream(), sink);
  const out = text();
  assert.ok(out.includes('"finish_reason":"stop"'));
  assert.ok(!out.includes('"error"'));
  assert.ok(out.includes('hello'));
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`✗ ${name}`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
