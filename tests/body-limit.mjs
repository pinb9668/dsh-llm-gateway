#!/usr/bin/env node
/**
 * 请求体上限的回归测试。
 *
 * 背景：Codex 每轮把整段历史重发，带图会话很容易几十 MB。旧实现的上限是 64 MB，
 * 超限回 413 —— 但**没有带 `x-should-retry: false`**，于是 Codex 把它当瞬时故障
 * 重连五轮（界面上「正在重新连接 5/5」），每轮重传几十 MB 换回同一句拒绝。
 *
 * 这些用例用假的 ctx 真正起一个网关，断言：
 *   1. 超限回 413，且带 `x-should-retry: false` 与 `retry-after: 0`；
 *   2. content-length 撒谎（缺失 / 分块）时仍按实际字节拦截；
 *   3. 上限可通过 config.maxBodyBytes 调整；
 *   4. 正常大小的请求不受影响。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { apply } from '../index.js';

let failures = 0;
let passed = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/** 拿一个当前空闲的端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 最小可用 ctx：只提供 apply() 真正会碰的那几项。 */
function fakeCtx() {
  const cleanups = [];
  return {
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
      stream: () => (async function* empty() {})(),
    },
    get: () => undefined,
    effect: (fn) => {
      cleanups.push(fn());
    },
    dispose: () => {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          /* already closed */
        }
      }
    },
  };
}

async function withGateway(config, run) {
  const port = await freePort();
  const ctx = fakeCtx();
  apply(ctx, { host: '127.0.0.1', port, ...config });
  await new Promise((resolve) => setTimeout(resolve, 80));
  try {
    await run({ port });
  } finally {
    ctx.dispose();
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

/** 发一个原始 POST；hideLength 模拟 content-length 缺失、走分块上传的客户端。 */
function post(port, path, body, { hideLength = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (hideLength) headers['transfer-encoding'] = 'chunked';
    else headers['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    if (hideLength) {
      req.write(body.slice(0, 1024));
      req.end(body.slice(1024));
    } else {
      req.end(body);
    }
  });
}

test('超限请求回 413，并显式声明不可重试', async () => {
  await withGateway({ maxBodyBytes: 4096 }, async ({ port }) => {
    const body = JSON.stringify({ model: 'buddy/deepseek-v4.1-flash', input: 'x'.repeat(8192) });
    const res = await post(port, '/v1/responses', body);
    assert.equal(res.status, 413, 'status 必须是 413');
    assert.equal(res.headers['x-should-retry'], 'false', '必须带 x-should-retry: false');
    assert.equal(res.headers['retry-after'], '0', '必须带 retry-after: 0');
    assert.match(res.text, /request body too large/);
  });
});

test('content-length 缺失（分块上传）时仍按实际字节拦截', async () => {
  await withGateway({ maxBodyBytes: 4096 }, async ({ port }) => {
    const body = JSON.stringify({ model: 'buddy/deepseek-v4.1-flash', input: 'y'.repeat(8192) });
    const res = await post(port, '/v1/responses', body, { hideLength: true });
    assert.equal(res.status, 413, '分块上传超限也必须 413');
    assert.equal(res.headers['x-should-retry'], 'false');
  });
});

test('上限可通过 config.maxBodyBytes 调整', async () => {
  await withGateway({ maxBodyBytes: 1024 * 1024 }, async ({ port }) => {
    const body = JSON.stringify({ model: 'nope', input: 'z'.repeat(8192) });
    const res = await post(port, '/v1/responses', body);
    assert.notEqual(res.status, 413, '未超限时不能回 413');
    assert.equal(res.status, 404, '请求体被接受后应走到模型解析，返回 404');
  });
});

test('默认上限容得下几十 MB 的带图历史', async () => {
  await withGateway({}, async ({ port }) => {
    const body = JSON.stringify({ model: 'nope', input: 'w'.repeat(80 * 1024 * 1024) });
    const res = await post(port, '/v1/responses', body);
    assert.notEqual(res.status, 413, '默认上限必须明显大于 64 MB');
    assert.equal(res.status, 404, '80 MB 的请求体应当被接受，然后由模型解析失败');
  });
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
