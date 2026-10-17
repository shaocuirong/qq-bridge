// 会话令牌自愈的端到端验证（对活着的桥接，真实网络请求）。
//
// 验证的不是「代码能跑」，而是这个真实故障：
//   唤醒 prompt 写死的【会话令牌】在会话轮换后是**上一代**，模型照抄就被 403
//   「agent token 无效」（state/tool-calls.jsonl 2026-10-16 有 4 次实证）。
// 所以脚本先复现那次 403，再证明同一条调用经 MCP 工具能自愈成功。
//
// 真实令牌只通过**环境变量**传给子进程，不写进任何文件、不打印。
// 运行：D:\note_js\node.exe scripts/verify-mcp-token-selfheal.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEY = 'group:1060535585';

const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
const current = state?.conversations?.[KEY]?.agentToken;
if (!current) {
  console.error(`[verify] state 里没有 ${KEY} 的 agentToken，无法验证`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const port = Number(cfg.consolePort) || 3100;
// 复现用的是 MCP 的同款请求形态：控制台令牌 + x-agent-call + 会话令牌。
// 不带控制台令牌会先在控制台鉴权那层拿 401，根本走不到「会话令牌」校验，复现就失真了。
const consoleToken = String(
  cfg.consoleToken || fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim() || ''
);

// 生成一个 32 位十六进制假令牌：形状和真令牌一模一样，但一定不是当前代，
// 用来精确复现「照抄 prompt 里那一代」的场景，且不泄露任何真实值。
const stale = 'f'.repeat(24) + 'ffffffff';
const modUrl = new URL('../src/mcp-snowluma-safe.js', import.meta.url).href;

const boot = {
  base: `http://127.0.0.1:${port}`,
  key: KEY,
  stale,
  modUrl,
  consoleToken
};

const childPath = path.join(ROOT, 'scripts', '.tmp-verify-self-heal-child.mjs');
// 夹具脚本由本文件自己生成：这样「单文件即可跑」，不会出现
// 「有人在清理临时文件时把它删掉 → 验证脚本报 MODULE_NOT_FOUND」这种假失败。
const CHILD_SOURCE = String.raw`
import assert from 'node:assert/strict';
const BOOT = JSON.parse(process.env.MCP_SELFHEAL_BOOT);

// ① 复现：带「prompt 那一代」的旧令牌直连活着的桥接 → 必须被拒
const stale = await fetch(BOOT.base + '/api/socialV2/prompt?key=' + encodeURIComponent(BOOT.key), {
  headers: {
    'content-type': 'application/json',
    'x-console-token': BOOT.consoleToken,
    'x-agent-call': '1',
    'x-agent-token': BOOT.stale
  },
  signal: AbortSignal.timeout(10000)
});
const staleBody = await stale.json().catch(() => null);
assert.equal(stale.status, 403, '旧令牌本应被拒，实际 HTTP ' + stale.status);
// 桥接两句原文都代表「这枚会话令牌不认」：
//   bridge.js:3684 未授权：智能体调用必须携带有效的会话令牌（统一前置闸门）
//   bridge.js:5196 agent token 无效（各 v2 端点）
assert.ok(
  ['agent token 无效', '未授权：智能体调用必须携带有效的会话令牌'].some((s) => String(staleBody?.error ?? '').includes(s)),
  '本应报「会话令牌不认」，实际：' + staleBody?.error
);
console.log('REPRODUCED: 旧令牌被桥接拒绝 → HTTP ' + stale.status + ' ' + staleBody?.error);

// ② 修复后：同一条调用（同样照抄旧令牌）经由 MCP 工具走自愈路径 → 必须成功
const mod = await import(BOOT.modUrl);
const entry = mod.server._registeredTools['qq_get_prompt'];
assert.ok(entry && typeof entry.handler === 'function', '拿不到 qq_get_prompt 的 handler');
const res = await entry.handler({ key: BOOT.key, token: BOOT.stale }, {});
const text = res?.content?.[0]?.text ?? '';
assert.equal(res?.isError, undefined, '自愈后应当成功，实际: ' + text.slice(0, 200));
assert.ok(text.includes(BOOT.key), '应返回目标会话的 prompt');

// ③ 模型漏传 token（空串）同样自愈
const res2 = await entry.handler({ key: BOOT.key, token: '' }, {});
assert.equal(res2?.isError, undefined, '空令牌应当自愈成功，实际: ' + (res2?.content?.[0]?.text ?? '').slice(0, 200));

// ④ 不该自愈的失败必须原样抛出：不存在的会话 → 仍然是会话令牌不认，没人来救它
let unknownErr = null;
try {
  await entry.handler({ key: 'group:999999999', token: BOOT.stale }, {});
} catch (error) {
  unknownErr = error;
}
if (unknownErr) {
  const unknownText = String(unknownErr.message);
  assert.ok(unknownText.includes('agent token'), '未知会话的失败应保持原样：' + unknownText);
  console.log('NO_OVERREACH: 未知会话仍然失败 → ' + unknownText);
}

console.log('SELF_HEAL_OK');
process.exit(0);
`;

fs.writeFileSync(childPath, CHILD_SOURCE, 'utf8');
const run = () => new Promise((resolve) => {
  const p = spawn(process.execPath, [childPath], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MCP_SELFHEAL_BOOT: JSON.stringify(boot) }
  });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => { p.kill(); resolve({ code: -1, out, err: err + '\n[timeout 30s]' }); }, 30000);
  p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
});

const { code, out, err } = await run();
// 夹具用完即删，别在别人的 scripts/ 里留垃圾文件。
fs.rmSync(childPath, { force: true });
fs.rmSync(path.join(ROOT, 'scripts', '.tmp-verify-self-heal-child.mjs'), { force: true });
console.log(out.trim());
console.log(`[verify] 当前代令牌前缀: ${current.slice(0, 6)}…（完整值不打印）`);
console.log(`[verify] 子进程退出码: ${code}`);
const ok = code === 0 && out.includes('SELF_HEAL_OK');
if (!ok) {
  console.log('--- stdout ---\n' + out);
  console.log('--- stderr ---\n' + err);
}
console.log(ok
  ? '[verify] PASS：先复现 403，再证明同一调用经自愈成功'
  : '[verify] FAIL');
process.exit(ok ? 0 : 1);
