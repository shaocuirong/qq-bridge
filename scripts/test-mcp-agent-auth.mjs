// 会话令牌自愈的单测（不联网、不碰真实 state，全部在临时目录里做）。
// 运行：D:\note_js\node.exe scripts/test-mcp-agent-auth.mjs
//
// 覆盖的是真实故障：
//   唤醒 prompt 里写死的【会话令牌】在桥接轮换会话后成为上一代令牌，模型照抄就被 403
//   「agent token 无效」反复拒绝（state/tool-calls.jsonl 2026-10-16 有 4 次实证）。
//   自愈要求：能按 key 取到**当前代**令牌；取不到时必须返回 null 让调用方兜底，绝不能抛。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAgentTokenFromState, isStaleTokenError } from '../src/mcp-agent-auth.js';

function makeRoot(conversations) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agent-auth-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'social-v2.json'), JSON.stringify({ conversations }), 'utf8');
  return root;
}

test('按 key 取当前代令牌（不是 prompt 里那一代）', () => {
  const root = makeRoot({
    'group:1060535585': { agentToken: 'current-generation-token' },
    'private:1761476025': { agentToken: 'private-token' }
  });
  assert.equal(readAgentTokenFromState(root, 'group:1060535585'), 'current-generation-token');
  assert.equal(readAgentTokenFromState(root, 'private:1761476025'), 'private-token');
});

test('每次调用都重新读盘：轮换后立刻拿到新令牌', () => {
  const root = makeRoot({ 'group:1': { agentToken: 'gen-1' } });
  assert.equal(readAgentTokenFromState(root, 'group:1'), 'gen-1');
  fs.writeFileSync(
    path.join(root, 'state', 'social-v2.json'),
    JSON.stringify({ conversations: { 'group:1': { agentToken: 'gen-2' } } }),
    'utf8'
  );
  assert.equal(readAgentTokenFromState(root, 'group:1'), 'gen-2');
});

test('未命中/异常一律返回 null，由调用方兜底（自愈不能变成新的故障点）', () => {
  const root = makeRoot({ 'group:1': { agentToken: 'gen-1' } });
  assert.equal(readAgentTokenFromState(root, 'group:999'), null, '未知会话');
  assert.equal(readAgentTokenFromState(root, ''), null, '空 key');
  assert.equal(readAgentTokenFromState(root, 'group:1'), 'gen-1');

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agent-auth-empty-'));
  assert.equal(readAgentTokenFromState(empty, 'group:1'), null, '状态文件缺失');

  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agent-auth-broken-'));
  fs.mkdirSync(path.join(broken, 'state'), { recursive: true });
  fs.writeFileSync(path.join(broken, 'state', 'social-v2.json'), '{ not json', 'utf8');
  assert.equal(readAgentTokenFromState(broken, 'group:1'), null, '状态文件损坏');

  const noToken = makeRoot({ 'group:1': { agentToken: '' } });
  assert.equal(readAgentTokenFromState(noToken, 'group:1'), null, 'agentToken 为空');
});

test('只有桥接自己那句「令牌不认」才触发自愈重试', () => {
  // 会自愈的（桥接源码里写死的原文）
  assert.equal(isStaleTokenError(new Error('agent token 无效')), true);
  assert.equal(isStaleTokenError(new Error('未授权：智能体调用必须携带有效的会话令牌')), true);
  assert.equal(isStaleTokenError(new Error('reserved2 模式发送必须携带 agent token')), true);
  assert.equal(isStaleTokenError('agent token 不能为空'), true);

  // 不该重试的：重试一次只是白烧一次请求，还可能掩盖真实原因
  assert.equal(isStaleTokenError(new Error('目标不在当前模式允许范围内')), false);
  assert.equal(isStaleTokenError(new Error('工具未启用：qq_send_message')), false);
  assert.equal(isStaleTokenError(new Error('本条回复因疑似包含敏感信息被安全策略拦截')), false);
  assert.equal(isStaleTokenError(new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数')), false);
  assert.equal(isStaleTokenError(undefined), false);
  assert.equal(isStaleTokenError(null), false);
});
