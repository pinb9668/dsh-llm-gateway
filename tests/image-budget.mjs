#!/usr/bin/env node
/**
 * 路由图片预算的回归测试。
 *
 * 背景：DSH 的 pi-ai 适配器对一条请求有硬预算（默认 50 张图 / 20 MB base64）。
 * 超了它抛 `IMAGE_OFFLOAD_REQUIRED`，并把「还要省略几张」交给
 * `dsh-compaction-image-offload` —— 后者靠在**会话**里记 `image/offload` 事件
 * 来记住哪些位置被省略。走网关时每轮都是新请求、图片块每轮重建，那条恢复链
 * 永远修不好同一个历史，于是 Codex 里反复断流：
 *
 *   stream disconnected before completion: pi-ai request images exceed the route
 *   image budget; 2 more oldest occurrence(s) must be offloaded.
 *
 * 网关现在的对策：自己在**请求内**按确定性规则省略最老的图片，让请求一次就
 * 装进预算。这些用例断言该行为：
 *   1. 图片数量超限时，省略最老的若干张，保留最新的；
 *   2. base64 字节超限时同样触发省略；
 *   3. 未超限时一张都不动；
 *   4. 省略后真的落在预算内（这是「不再触发适配器报错」的充要条件）。
 */

import assert from 'node:assert/strict';

import { applyImageBudget } from '../index.js';

let failures = 0;
let passed = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/** 造一条带 n 张图的消息，每张 approxBytes 字节。 */
function makeMessages(sizes) {
  const content = sizes.map((bytes, index) => ({
    type: 'image',
    attachment: { attachmentId: `a${index}`, mediaType: 'image/png', bytes, width: 64, height: 64 },
  }));
  return [{ id: 'm1', role: 'user', content }];
}

function imagesLeft(messages) {
  return messages[0].content.filter((block) => block.type === 'image').length;
}

function retainedBytes(messages) {
  return messages[0].content
    .filter((block) => block.type === 'image')
    .reduce((sum, block) => sum + Math.ceil(block.attachment.bytes / 3) * 4, 0);
}

test('图片数量超限：省略最老的，保留最新的', async () => {
  const sizes = Array.from({ length: 60 }, () => 100 * 1024);
  const messages = makeMessages(sizes);
  const omitted = applyImageBudget(messages, { maxImages: 50, maxBytes: 1024 * 1024 * 1024 });
  assert.equal(omitted, 10, '应省略 10 张');
  assert.equal(imagesLeft(messages), 50, '应保留 50 张');
  // 最老的 10 个位置被换成占位文本
  assert.equal(messages[0].content[0].type, 'text', '最老那张应被省略');
  assert.equal(messages[0].content[9].type, 'text', '第 10 张应被省略');
  assert.equal(messages[0].content[10].type, 'image', '第 11 张应保留');
});

test('base64 字节超限：同样从最老的开始省略', async () => {
  // 每张 ~1 MiB → base64 ~1.33 MiB；20 张约 26.7 MiB，超过 20 MiB 预算
  const sizes = Array.from({ length: 20 }, () => 1024 * 1024);
  const messages = makeMessages(sizes);
  const omitted = applyImageBudget(messages, { maxImages: 50, maxBytes: 20 * 1024 * 1024 });
  assert.ok(omitted > 0, '字节超限时必须省略图片');
  assert.ok(
    retainedBytes(messages) <= Math.floor(20 * 1024 * 1024 * 0.95),
    '省略后必须真的落在预算内（含 5% 余量）',
  );
});

test('未超限时一张都不动', async () => {
  const messages = makeMessages([100 * 1024, 100 * 1024]);
  const omitted = applyImageBudget(messages, { maxImages: 50, maxBytes: 20 * 1024 * 1024 });
  assert.equal(omitted, 0);
  assert.equal(imagesLeft(messages), 2);
});

test('默认预算下 55 张图被压到 50 张以内', async () => {
  const sizes = Array.from({ length: 55 }, () => 50 * 1024);
  const messages = makeMessages(sizes);
  const omitted = applyImageBudget(messages, {});
  assert.ok(omitted >= 5, '至少要省略 5 张');
  assert.ok(imagesLeft(messages) <= 50, '最终不超过 50 张');
});

for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${name}`);
    console.error(`  ${error?.message ?? error}`);
  }
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}（通过 ${passed}/${tests.length}）`);
if (failures > 0) process.exit(1);
