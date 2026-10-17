import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolAutomationRuntime, normalizeToolAutomationRules, safeWakeEvent } from '../src/tool-automations.js';

test('event and scheduled tool wakes obey scopes, cooldowns, tool switches and pause', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tool-automation-'));
  const cfg = { socialV2: { tools: { memory: true } } };
  let clock = 1_000_000; let active = true; const sent = [];
  const runtime = createToolAutomationRuntime({ root, now: () => clock, getConfig: () => cfg,
    isAllowed: key => key === 'group:456', isActive: () => active,
    dispatch: (key, context) => sent.push({ key, context }) });
  const rule = { id: 'memory-wake', name: '记忆例行检查', enabled: true, tools: ['qq_memory_query'], keys: ['group:456'], events: ['message', 'notice:group_increase'], intervalMinutes: 1, cooldownSeconds: 10, prompt: '查看 {{key}}，工具 {{tools}}；事件 {{event}}', reference: 'proactive' };
  try {
    runtime.replace([rule]);
    runtime.event({ post_type: 'message', group_id: 999, user_id: 123, raw_message: 'not in scope' });
    assert.equal(sent.length, 0);
    runtime.event({ post_type: 'message', group_id: 456, user_id: 123, raw_message: '你好', flag: 'must-not-leak', token: 'must-not-leak' });
    assert.equal(sent.length, 1); assert.ok(sent[0].context.prompt.includes('group:456'));
    assert.equal(sent[0].context.event.includes('must-not-leak'), false);
    runtime.event({ post_type: 'message', group_id: 456 }); assert.equal(sent.length, 1);
    clock += 10001; runtime.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 456 }); assert.equal(sent.length, 2);
    runtime.tick(); clock += 60000; runtime.tick(); assert.equal(sent.length, 3); assert.equal(sent.at(-1).context.source, 'schedule');
    active = false; clock += 60000; runtime.tick(); runtime.event({ post_type: 'message', group_id: 456 }); assert.equal(sent.length, 3);
    active = true; cfg.socialV2.tools.memory = false; clock += 60000; runtime.tick(); runtime.event({ post_type: 'message', group_id: 456 }); assert.equal(sent.length, 3);
    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'state/tool-automations.json'))); assert.equal(persisted.rules.length, 1);
    assert.throws(() => runtime.replace([{ ...rule, keys: ['group:999'] }]), /范围/);
    assert.equal(runtime.view().rules[0].keys[0], 'group:456');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('invalid tool names, scopes, schedule bounds and payload shapes are rejected', () => {
  const rule = { id: 'x', tools: ['qq_memory_query'], keys: ['group:456'], events: ['message'], prompt: '检查', cooldownSeconds: 60 };
  for (const patch of [{ tools: ['bash'] }, { keys: ['../456'] }, { intervalMinutes: 0.01 }, { cooldownSeconds: 0 }, { events: ['arbitrary:execute'] }, { prompt: '' }]) {
    assert.throws(() => normalizeToolAutomationRules([{ ...rule, ...patch }]));
  }
  assert.equal(safeWakeEvent({ post_type: 'request', flag: 'private', accessToken: 'private' }).flag, undefined);
});
