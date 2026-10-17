// 一次性验证：过期的 readThroughSeq 不再卡死收尾（qq_mark_read / qq_set_wake_config）。
//
// 真实度：真起一个 MCP 子进程（stdio 客户端连它），假桥接是一个真 HTTP server，
// 按请求逐条决定响应 —— 跟脚本 test-qq-model-view.mjs 的同款做法，但用例独立成文件，
// 不去改别人正在维护的测试。
//
// 验证三件事：
//   ① 水位过期 → 先补读一次当前未读，再用**桥接返回的**水位重试（不许自己抬高）；
//   ② 结果里显式告诉模型水位被刷新过（refreshedThroughSeq）；
//   ③ 非「水位过期」的失败原样抛出，不做补读重试。
//
// 运行：D:\note_js\node.exe scripts/verify-mcp-ack-fresh-seq.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'group:123';
const SEQ_ERROR = 'throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq';

const seen = [];
// 每条请求一个应答（按顺序取用）；返回 null 表示走默认应答。
let responder = () => null;

const readBody = async (req) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
};

const api = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const entry = { url: req.url, method: req.method, body, token: req.headers['x-agent-token'] };
  seen.push(entry);
  const custom = responder(entry);
  res.writeHead(custom?.status ?? 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(custom?.body ?? { ok: true, readThroughSeq: 21, messages: [] }));
});

await new Promise((resolve, reject) => {
  api.once('error', reject);
  api.listen(0, '127.0.0.1', resolve);
});

const fixture = fs.mkdtempSync(path.join(ROOT, '.tmp-mcp-ack-'));
let client = null;
let failed = null;
try {
  await fs.promises.mkdir(path.join(fixture, 'src'));
  await Promise.all(['mcp-snowluma-safe.js', 'mcp-agent-auth.js', 'qq-model-view.js', 'sensitive.js'].map((name) =>
    fs.promises.copyFile(path.join(ROOT, 'src', name), path.join(fixture, 'src', name))));
  await fs.promises.writeFile(path.join(fixture, 'config.json'), JSON.stringify({ consolePort: api.address().port }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(fixture, 'src', 'mcp-snowluma-safe.js')],
    cwd: fixture,
    stderr: 'pipe'
  });
  client = new Client({ name: 'ack-fresh-seq-verify', version: '1.0.0' });
  await client.connect(transport);
  const common = { key: KEY, token: 'fixture-token' };

  // ── ① 水位过期 → 补读 → 用新水位重试 ──────────────────────────────────────
  seen.length = 0;
  responder = (entry, index = seen.length - 1) => {
    if (seen.length === 1) {
      assert.equal(entry.url, '/api/socialV2/mark-read');
      assert.equal(entry.body?.throughSeq, 99, '第一次必须原样带上模型给的过期水位');
      return { status: 400, body: { ok: false, error: SEQ_ERROR } };
    }
    if (seen.length === 2) {
      assert.equal(entry.url, '/api/socialV2/unread?key=group%3A123&limit=30', '被拒后必须补读当前未读');
      return { body: { ok: true, readThroughSeq: 21, messages: [{ seq: 21 }] } };
    }
    assert.equal(entry.url, '/api/socialV2/mark-read');
    assert.equal(entry.body?.throughSeq, 21, '重试必须用桥接返回的水位，不许自己抬高');
    return { body: { ok: true, acknowledged: true, throughSeq: 21 } };
  };
  const healed = await client.callTool({ name: 'qq_mark_read', arguments: { ...common, throughSeq: 99 } });
  const healedText = healed.content.find((part) => part.type === 'text').text;
  assert.notEqual(healed.isError, true, `过期水位应当自愈，实际：${healedText}`);
  assert.deepEqual(seen.map((r) => r.url), [
    '/api/socialV2/mark-read',
    '/api/socialV2/unread?key=group%3A123&limit=30',
    '/api/socialV2/mark-read'
  ], '必须是「先试 → 补读 → 用新水位重试」三步');
  const healedData = JSON.parse(healedText);
  assert.equal(healedData.readThroughSeq, 21, '必须用桥接返回的水位');
  assert.equal(healedData.refreshedThroughSeq, true, '要显式告诉模型水位被刷新过');
  console.log('PASS ①：过期水位 → 补读 → 用桥接给的新水位重试，且不抬水位');

  // ── ② 非水位类失败必须原样抛出，不补读重试 ─────────────────────────────────
  seen.length = 0;
  responder = () => ({
    status: 400,
    body: { ok: false, error: '还不能立刻设置潜水/下一次唤醒：还需等待约 5 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察。' }
  });
  const refused = await client.callTool({ name: 'qq_set_wake_config', arguments: { ...common, config: { mode: 'diving' }, throughSeq: 5 } });
  assert.equal(refused.isError, true, '沉睡前观察没做完必须仍然失败');
  assert.equal(seen.length, 1, `非水位类失败必须只发一次请求，实际 ${seen.length} 次`);
  assert.match(refused.content.find((p) => p.type === 'text').text, /沉睡前观察/);
  console.log('PASS ②：非水位类失败原样抛出，没有多余重试');

  // ── ③ 水位合法时行为不变（不补读、不改写模型的入参）────────────────────────
  seen.length = 0;
  responder = () => ({ body: { ok: true, acknowledged: true } });
  await client.callTool({ name: 'qq_mark_read', arguments: { ...common, throughSeq: 21 } });
  assert.equal(seen.length, 1, '水位合法时不应补读');
  assert.equal(seen[0].url, '/api/socialV2/mark-read');
  assert.deepEqual(seen[0].body, { key: KEY, throughSeq: 21 });
  console.log('PASS ③：水位合法时单次调用，入参不被改写');
} catch (error) {
  failed = error;
} finally {
  if (client) { try { await client.close(); } catch {} }
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
  const resolved = path.resolve(fixture);
  assert.equal(path.dirname(resolved), ROOT, 'fixture 必须建在项目根下，清理路径要能自证');
  assert.ok(path.basename(resolved).startsWith('.tmp-mcp-ack-'), 'fixture 目录名必须匹配清理前缀');
  await fs.promises.rm(resolved, { recursive: true, force: true });
}

if (failed) {
  console.error('[verify] FAIL：', failed?.message ?? failed);
  process.exit(1);
}
console.log('[verify] PASS：readThroughSeq 过期不再卡死收尾');
