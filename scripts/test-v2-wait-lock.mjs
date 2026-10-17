// 长轮询等待锁的回归测试（对应线上「该会话已有一个等待中的等待」死锁）。
//
// 背景：桥接把等待锁的释放挂在 `req.on('close')` 上，但 Node ≥16 的 IncomingMessage
// 在「请求体读完」时就发 close（不是客户端断开），而注册发生在 `await readBody()` 之后，
// 于是监听器永远收不到 —— 客户端中途放弃这次长轮询时锁不释放，同一会话之后每次
// qq_wait_for_messages 都是 429，mark_read / set_wake_config 又因缺少沉睡前观察被拒。
//
// 本测试同时验证：
// 1. 行为：用真实 HTTP 复现「客户端 AbortSignal.timeout 中断 → 锁必须立刻释放」；
// 2. 行为：并发等待仍然被拒（429），正常结束后锁自动释放；
// 3. 行为：租约到期后残留锁可被接管；expectedReleaseAt 能算出 releaseInMs；
// 4. 源码：bridge.js / mcp-snowluma-safe.js 保持修复后的形状（防止回退到 req 监听、
//    以及客户端预算短于桥接硬截止）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWaitLock } from '../src/wait-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failed = 0;
function assert(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { console.error(`❌ ${label}`); failed = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 写死掉的响应（客户端已断开）若没人兜底会抛 ERR_STREAM_DESTROYED —— 这里把它当成测试失败。
process.on('unhandledRejection', (error) => {
  console.error('❌ 出现未处理的 rejection（等待路由往已断开的响应写？）:', error?.message ?? error);
  failed = 1;
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

// ── 1/2. 真实 HTTP：复刻桥接等待路由的锁用法 ────────────────────────────────
const lock = createWaitLock({ leaseMs: 15 * 60 * 1000 });
let handlerDone = 0;

const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const key = String(body.key || '');
  const budgetMs = Number(body.budgetMs) || 5000;

  const hold = lock.acquire(key);
  if (!hold) {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'busy', ...(lock.heldInfo(key) || {}) }));
    return;
  }
  let aborted = false;
  hold.bind(res, () => { aborted = true; });          // 修复点：绑 res，不是 req
  const start = Date.now();
  hold.expectedReleaseAt = start + budgetMs + 12000 + 5000;
  while (!aborted && Date.now() - start < budgetMs) await sleep(20);
  hold.release();
  handlerDone += 1;
  // 与 bridge.js 等待路由同形：客户端已断开就不写响应。
  const clientGone = () => aborted || res.destroyed;
  if (!clientGone() && !res.writableEnded) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, aborted, waitedMs: Date.now() - start }));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/socialV2/wait`;

// 1. 客户端中断 → 锁立刻释放（修复前要等 handler 跑完 5 秒预算）
try {
  await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'group:test-abort', budgetMs: 5000 }),
    signal: AbortSignal.timeout(200)
  });
  assert(false, '客户端 200ms 超时应当中断长轮询');
} catch (error) {
  assert(error?.name === 'TimeoutError' || /abort/i.test(String(error?.message)), '客户端 200ms 超时中断长轮询（预期行为）');
}
await sleep(250);
assert(lock.heldInfo('group:test-abort') === null, '客户端中断后 250ms 内等待锁已释放（不再残留 429）');
await sleep(300);
assert(handlerDone === 1, '被中断的等待循环已提前退出（没有空转到 5 秒预算）');

// 2. 并发等待仍被拒；正常结束后自动放锁
const first = fetch(base, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: 'group:test-busy', budgetMs: 1500 })
});
await sleep(200);
const busyRes = await fetch(base, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: 'group:test-busy', budgetMs: 100 })
});
const busyBody = await busyRes.json();
assert(busyRes.status === 429 && busyBody.ok === false, '同一会话的并发等待被拒（429）');
assert(Number.isFinite(busyBody.releaseInMs) && busyBody.releaseInMs > 0, `429 里带 releaseInMs（${busyBody.releaseInMs}ms）供调用方决定等多久`);
const firstRes = await first;
const firstBody = await firstRes.json();
assert(firstRes.status === 200 && firstBody.ok === true && firstBody.aborted === false, '先到的等待正常返回（未被误判中断）');
assert(lock.heldInfo('group:test-busy') === null, '正常返回后等待锁已释放');
const afterRes = await fetch(base, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: 'group:test-busy', budgetMs: 50 })
});
assert(afterRes.status === 200, '前一次结束后可以立刻发起新的等待');
await afterRes.json();

await new Promise((resolve) => server.close(resolve));

// ── 3. 租约与 releaseInMs ───────────────────────────────────────────────────
const shortLock = createWaitLock({ leaseMs: 60 });
const h = shortLock.acquire('k');
assert(h !== null, '空锁可以获取');
assert(shortLock.acquire('k') === null, '同一 key 第二次获取被拒');
await sleep(90);
assert(shortLock.heldInfo('k') === null, '租约到期后残留锁视为失效');
assert(shortLock.acquire('k') !== null, '租约到期后允许接管');

const infoLock = createWaitLock({ leaseMs: 60000 });
const h2 = infoLock.acquire('k2');
h2.expectedReleaseAt = Date.now() + 3000;
const info = infoLock.heldInfo('k2');
assert(info && info.releaseInMs > 2000 && info.releaseInMs <= 3000, `heldInfo 按 expectedReleaseAt 给出 releaseInMs（${info?.releaseInMs}ms）`);
infoLock.release('k2');
assert(infoLock.heldInfo('k2') === null, 'release(key) 可强制清锁（会话退役路径）');

// ── 4. 源码形状（防止回退） ────────────────────────────────────────────────
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');

assert(!/req\.on\('close',\s*finishWait\)/.test(bridgeSrc), 'bridge.js 不再把放锁挂在 req 的 close 上（Node ≥16 收不到）');
assert(!/req\.on\('close',\s*\(\)\s*=>\s*\{\s*aborted\s*=\s*true/.test(bridgeSrc), 'bridge.js 不再用 req 的 close 置 aborted');
assert(/hold\.bind\(res,/.test(bridgeSrc), 'bridge.js 通过 wait-lock 的 bind(res) 释放锁');
assert(/const hardDeadlineAt = start \+ timeoutMs \+ quietMs \+ 5000;/.test(bridgeSrc), 'bridge.js 等待硬截止 = timeoutMs + quietMs + 5000');
assert(/waits: waitLock\.list\(\)/.test(bridgeSrc), '/api/status 暴露正在等待的会话（控制台可诊断 429）');
assert(/if \(!clientGone\(\)\) sendJson/.test(bridgeSrc), '403 分支不往已断开的响应写');
assert(/if \(clientGone\(\)\) return;\s*\n\s*sendJson\(\{\s*\n\s*ok: true,/.test(bridgeSrc), '等待正常结束前同样跳过已断开的响应');
assert(/timeoutMs: Math\.min\(780000, \(Number\(timeoutMs\) \|\| 30000\) \+ 120000 \+ 35000\)/.test(mcpSrc), 'MCP 客户端预算覆盖桥接最坏情况（+120000 静默窗口 + 35s 余量）');

// 客户端预算必须严格长于桥接硬截止（默认 maxMs=600000、静默窗口上限 120000）
const bridgeWorstMs = 600000 + 120000 + 5000;
const clientWorstMs = Math.min(780000, 600000 + 120000 + 35000);
assert(clientWorstMs > bridgeWorstMs, `客户端预算 ${clientWorstMs}ms > 桥接硬截止 ${bridgeWorstMs}ms`);

if (failed) {
  console.error('\n❌ 等待锁回归测试失败');
  process.exit(1);
}
console.log('\n🎉 等待锁回归测试通过');
