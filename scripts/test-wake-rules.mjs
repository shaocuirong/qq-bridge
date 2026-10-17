import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWakeRuleRuntime, normalizeWakeRules, safeWakeEvent } from '../src/wake-rules.js';
import { DEFAULT_WAKE_PROMPTS } from '../src/wake-prompts.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
const rule = { id: 'event-wake', name: '群成员变化', enabled: true, keys: ['group:456'], events: ['message', 'notice:group_increase'], intervalMinutes: 1, cooldownSeconds: 10, prompt: '查看 {{key}}；事件 {{event}}；时间 {{time}}', reference: 'event' };
function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-wake-rules-'));
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('events and schedules use scopes, cooldowns and pause without tool prerequisites', () => fixture(root => {
  let clock = 1_000_000, active = true; const sent = [];
  const runtime = createWakeRuleRuntime({ root, now: () => clock, isAllowed: key => key === 'group:456', isActive: () => active, dispatch: (key, context) => sent.push({ key, context }) });
  runtime.replace([rule]);
  runtime.event({ post_type: 'message', group_id: 999, user_id: 123 }); assert.equal(sent.length, 0);
  runtime.event({ post_type: 'message', group_id: 456, user_id: 123, raw_message: '你好', flag: 'must-not-leak', token: 'must-not-leak' });
  assert.equal(sent.length, 1); assert.ok(sent[0].context.prompt.includes('group:456'));
  assert.equal(sent[0].context.event.includes('must-not-leak'), false); assert.equal(Object.hasOwn(sent[0].context, 'tools'), false);
  runtime.event({ post_type: 'message', group_id: 456 }); assert.equal(sent.length, 1);
  clock += 10001; runtime.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 456 }); assert.equal(sent.length, 2);
  clock += 50000; runtime.tick(); assert.equal(sent.length, 3); assert.equal(sent.at(-1).context.source, 'schedule');
  active = false; clock += 60000; runtime.tick(); runtime.event({ post_type: 'message', group_id: 456 }); assert.equal(sent.length, 3);
  active = true; runtime.tick(); assert.equal(sent.length, 3, '暂停期间不补跑');
  clock += 60000; runtime.tick(); assert.equal(sent.length, 4);
  assert.throws(() => runtime.replace([{ ...rule, keys: ['group:999'] }]), /范围/);
  assert.equal(runtime.view().rules[0].keys[0], 'group:456');
}));

test('saving another rule or scene prompt preserves existing timers and cooldowns', () => fixture(root => {
  let clock = 1_000_000; const sent = [];
  const runtime = createWakeRuleRuntime({ root, now: () => clock, isAllowed: () => true, isActive: () => true, dispatch: (...args) => sent.push(args) });
  runtime.replace([rule]); runtime.event({ post_type: 'message', group_id: 456 });
  const due = runtime.view().schedules[0].nextRunAt;
  clock += 1000;
  runtime.replace([rule, { ...rule, id: 'other', enabled: false }], { message: '新的消息唤醒 {{key}}' });
  assert.equal(runtime.view().schedules[0].nextRunAt, due);
  runtime.event({ post_type: 'message', group_id: 456 }); assert.equal(sent.length, 1);
  assert.equal(runtime.prompt('message', { key: 'group:456' }), '新的消息唤醒 group:456');
  clock += 59000; runtime.tick(); assert.equal(sent.length, 2);
  const context = sent[0][1];
  runtime.replace([{ ...rule, prompt: '改写后的任务' }]);
  assert.equal(runtime.isRuleActive(context.ruleId, 'group:456', context.revision), false, '改写后不投递旧上下文');
}));

test('legacy tool-linked rules migrate without retaining a tool selector or tool gate', () => fixture(root => {
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'state/tool-automations.json'), JSON.stringify({ version: 1, rules: [{ ...rule, tools: ['qq_memory_query'], prompt: '使用 {{tools}} 检查 {{event}}' }] }));
  const sent = [];
  const runtime = createWakeRuleRuntime({ root, isAllowed: () => true, isActive: () => true, dispatch: (...args) => sent.push(args) });
  assert.equal(Object.hasOwn(runtime.view().rules[0], 'tools'), false);
  runtime.event({ post_type: 'message', group_id: 456 }); assert.equal(sent.length, 1);
  assert.ok(sent[0][1].prompt.includes('当前已启用的工具'));
  runtime.replace(undefined, { proactiveCheck: '自定义主动机会 {{key}}' });
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'state/wake-rules.json')));
  assert.equal(saved.version, 2); assert.equal(saved.rules[0].tools, undefined);
  const reloaded = createWakeRuleRuntime({ root, isAllowed: () => true, isActive: () => true, dispatch() {} });
  assert.equal(reloaded.prompt('proactiveCheck', { key: 'group:456' }), '自定义主动机会 group:456');
  assert.equal(reloaded.view().prompts.find(p => p.id === 'message').text, DEFAULT_WAKE_PROMPTS.message);
}));

test('unknown scopes, triggers, schedules and prompt shapes are rejected atomically', () => fixture(root => {
  for (const patch of [{ keys: ['../456'] }, { intervalMinutes: 0.01 }, { cooldownSeconds: 0 }, { events: ['arbitrary:execute'] }, { prompt: '' }, { events: [], intervalMinutes: 0 }, { snapshotLimit: -1 }, { snapshotLimit: 101 }, { snapshotLimit: 1.5 }]) {
    assert.throws(() => normalizeWakeRules([{ ...rule, ...patch }]));
  }
  const sent = [];
  const runtime = createWakeRuleRuntime({ root, isAllowed: () => true, isActive: () => true, dispatch: (...args) => sent.push(args) });
  runtime.replace([{ ...rule, events: ['notice:*', 'meta_event:heartbeat'] }]);
  assert.throws(() => runtime.replace(undefined, { unknown: 'bad' }));
  assert.throws(() => runtime.replace(undefined, { message: '' }));
  runtime.event({ post_type: 'notice', notice_type: 'group_increase' }); assert.equal(sent.length, 0, '归属不明的通知不广播');
  runtime.event({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: true } }); assert.equal(sent.length, 1);
  assert.equal(safeWakeEvent({ post_type: 'request', flag: 'private', accessToken: 'private' }).flag, undefined);
}));

test('event snapshots use the requested latest count, include cooldown arrivals and isolate targets/types', () => fixture(root => {
  let clock = 1_000_000;
  const runtime = createWakeRuleRuntime({ root, now: () => clock, isAllowed: () => true, isActive: () => true,
    redact: text => text.replaceAll('known-secret', '[redacted]'), dispatch() {} });
  runtime.replace([{ ...rule, events: ['notice:group_increase'], snapshotLimit: 2 }]);
  for (let index = 1; index <= 4; index++) {
    runtime.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 456, user_id: index, comment: 'known-secret', flag: 'never-store' });
    clock += 1;
  }
  runtime.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 999, user_id: 900 });
  runtime.event({ post_type: 'message', group_id: 456, user_id: 901, raw_message: 'other event kind' });
  const snapshot = runtime.snapshot(rule.id, 'group:456');
  assert.deepEqual(snapshot.events.map(e => e.data.user_id), [3, 4]);
  assert.equal(snapshot.availableCount, 4); assert.equal(snapshot.requestedLimit, 2); assert.equal(snapshot.partial, true);
  assert.equal(JSON.stringify(snapshot).includes('known-secret'), false); assert.equal(JSON.stringify(snapshot).includes('never-store'), false);
  assert.equal(runtime.snapshot(rule.id, 'group:999'), null);
  runtime.replace([{ ...rule, snapshotLimit: 0 }]); assert.equal(runtime.snapshot(rule.id, 'group:456'), null);
  runtime.replace([{ ...rule, events: [], snapshotLimit: 100 }]);
  for (let index = 0; index < 50; index++) runtime.event({ post_type: 'message', group_id: 456, raw_message: '大'.repeat(800), user_id: index + 10 });
  const large = runtime.snapshot(rule.id, 'group:456');
  assert.ok(JSON.stringify(large).length <= 12000); assert.equal(large.partial, true);
  assert.equal(large.events.at(-1).data.user_id, 59);
}));

test('an event wake queued while busy survives without unread messages, and disabled rules do not revive', async () => {
  const h = await bridgeHarness({ config: { socialV2: { wake: { batchWindowMs: 60000 } } } });
  try {
    h.setMode('reserved2'); h.setReady(true);
    const key = 'group:456', st = h.getSocialV2State(key);
    const sid = await h.ensureSession(key);
    h.collectors.set(sid, { stub: true }); h.v2TurnStartAt.set(sid, Date.now());
    h.wakeRules.replace([{ ...rule, intervalMinutes: 0, events: ['notice:group_increase'], snapshotLimit: 2 }]);
    for (const user_id of [111, 222, 333]) h.wakeRules.event({ post_type: 'notice', notice_type: 'group_increase', group_id: 456, user_id });
    const prompt = h.buildWakePromptV2(key, 'wakeRule');
    const snapshotJson = prompt.match(/【事件快照，仅作上下文】([^\n]+)/)?.[1];
    assert.ok(snapshotJson); assert.deepEqual(JSON.parse(snapshotJson).events.map(e => e.data.user_id), [222, 333]);
    assert.equal(st.unread.length, 0); assert.equal(st.pendingWakeReasons[0].reason, 'wakeRule');
    h.collectors.delete(sid); h.v2TurnStartAt.delete(sid);
    h.sweepPendingWakeReasonsV2(); assert.ok(st.pendingWakeTimer, '没有未读消息也必须重排任务');
    clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null;
    h.wakeRules.replace([{ ...rule, enabled: false }]);
    const before = h.calls.prompts.length;
    await h.sendWakePromptV2(key, 'wakeRule'); assert.equal(h.calls.prompts.length, before);
  } finally { await h.close(); }
});
